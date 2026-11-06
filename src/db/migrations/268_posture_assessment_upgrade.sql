-- ─────────────────────────────────────────────────────────────────────────
-- 268 — Postural Assessment: structured observations, evidence and plan
-- ─────────────────────────────────────────────────────────────────────────
--
-- The original table could hold three flat lists of strings, a single notes
-- field and six coach-note paragraphs. The assessment now records the view a
-- finding belongs to, the photographs it was read from, confirmed muscle
-- findings, a corrective plan and a draft/completed lifecycle.
--
-- Nothing existing is renamed, dropped or rewritten:
--   front_issues / side_issues / back_issues / other_issue_notes / coach_notes
-- keep every stored value and stay readable/writable. The new collections are
-- additive JSONB, so a row saved before this migration still opens and saves.
--
-- All columns are nullable except status, which defaults to 'completed' so
-- historical rows are not presented to trainers as unfinished drafts.
-- Additive and idempotent. No BEGIN/COMMIT — migrate.js wraps this.

ALTER TABLE pt_posture_assessments
  ADD COLUMN IF NOT EXISTS assessment_type TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS view_notes JSONB,
  ADD COLUMN IF NOT EXISTS front_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS side_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS back_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS muscle_imbalances JSONB,
  ADD COLUMN IF NOT EXISTS corrective_plan JSONB,
  ADD COLUMN IF NOT EXISTS assessment_summary JSONB,
  ADD COLUMN IF NOT EXISTS resolved_findings TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_posture_assessments_status_check'
       AND conrelid = 'pt_posture_assessments'::regclass
  ) THEN
    ALTER TABLE pt_posture_assessments
      ADD CONSTRAINT pt_posture_assessments_status_check
      CHECK (status IN ('draft', 'completed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pt_posture_assessments_type_check'
       AND conrelid = 'pt_posture_assessments'::regclass
  ) THEN
    ALTER TABLE pt_posture_assessments
      ADD CONSTRAINT pt_posture_assessments_type_check
      CHECK (assessment_type IS NULL OR assessment_type IN (
        'initial', 'follow_up', 're_assessment', 'progress'
      ));
  END IF;
END $$;

-- History is read per client, newest first; draft resumption filters the same
-- path on status.
CREATE INDEX IF NOT EXISTS idx_pt_posture_assessments_client_status
  ON pt_posture_assessments (client_id, status, assessment_date DESC);

-- Rows completed before the lifecycle columns existed have no completed_at.
-- updated_at is the closest honest timestamp already stored; never NOW(),
-- which would claim every historical assessment was completed today.
UPDATE pt_posture_assessments
   SET completed_at = COALESCE(updated_at, created_at)
 WHERE status = 'completed' AND completed_at IS NULL;
