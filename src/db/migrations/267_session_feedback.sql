-- ============================================================
-- 265_session_feedback.sql
-- Post-session feedback and trainer rating.
--
-- One row per PT session, created when the trainer marks the session
-- completed. The row starts 'pending' with no answers. The client's own
-- submission fills the five answers and the server-computed score, and moves
-- it to 'submitted'. UNIQUE(session_id) is the database's one-submission rule;
-- the application's UPDATE ... WHERE status = 'pending' makes the race
-- resolve to one winner.
--
-- ── Why the answers are columns, not JSONB ─────────────────────────────────
--
-- Each question is a closed set (four, four, three, three options, then a
-- 1–5 star answer). Columns let the CHECK constraints reject an option the UI
-- does not offer, and let the distribution and low-rating queries aggregate
-- without unpacking a blob. The one free-text field is optional.
--
-- ── Weights ────────────────────────────────────────────────────────────────
--
-- The weights are application configuration (lib/sessionFeedback.js), not a
-- database constraint. The score is stored on the row so a later weight change
-- never rewrites history; aggregates read the stored value.
--
-- Additive and idempotent.
-- ============================================================

ALTER TABLE pt_sessions
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN pt_sessions.completed_at IS
  'When the session moved to completed. The feedback request copies this timestamp.';

CREATE TABLE IF NOT EXISTS pt_session_feedback (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id        UUID NOT NULL,
  session_id             TEXT NOT NULL REFERENCES pt_sessions(id) ON DELETE CASCADE,
  client_id              TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  trainer_id             TEXT REFERENCES trainers(id) ON DELETE SET NULL,
  completed_at           TIMESTAMPTZ NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','submitted')),
  trainer_behaviour      TEXT
                           CHECK (trainer_behaviour IN ('excellent','good','average','poor')),
  form_technique         TEXT
                           CHECK (form_technique IN ('always','mostly','sometimes','no')),
  workout_intensity      TEXT
                           CHECK (workout_intensity IN ('perfect','too_easy','too_hard')),
  motivation_guidance    TEXT
                           CHECK (motivation_guidance IN ('absolutely','somewhat','not_really')),
  overall_stars          SMALLINT CHECK (overall_stars BETWEEN 1 AND 5),
  additional_feedback    TEXT,
  score                  NUMERIC(4,2) CHECK (score >= 0 AND score <= 5),
  submitted_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pt_session_feedback_session_unique UNIQUE (session_id),
  -- A pending request carries no answers; a submitted one carries all of
  -- them, a score and the moment it arrived. A half-written submission can
  -- never be read as a rating.
  CONSTRAINT pt_session_feedback_submitted_shape CHECK (
    (status = 'pending'
      AND trainer_behaviour IS NULL
      AND form_technique IS NULL
      AND workout_intensity IS NULL
      AND motivation_guidance IS NULL
      AND overall_stars IS NULL
      AND score IS NULL
      AND submitted_at IS NULL)
    OR
    (status = 'submitted'
      AND trainer_behaviour IS NOT NULL
      AND form_technique IS NOT NULL
      AND workout_intensity IS NOT NULL
      AND motivation_guidance IS NOT NULL
      AND overall_stars IS NOT NULL
      AND score IS NOT NULL
      AND submitted_at IS NOT NULL)
  )
);

-- The member's pending cards and history.
CREATE INDEX IF NOT EXISTS pt_session_feedback_client
  ON pt_session_feedback (client_id, status, completed_at DESC);

-- The studio's pending queue and rating list.
CREATE INDEX IF NOT EXISTS pt_session_feedback_org_status
  ON pt_session_feedback (organization_id, status, completed_at DESC);

-- The trainer analytics, filtered by trainer and date.
CREATE INDEX IF NOT EXISTS pt_session_feedback_trainer
  ON pt_session_feedback (organization_id, trainer_id, submitted_at DESC)
  WHERE status = 'submitted';

-- Low-rating review and score-band filters.
CREATE INDEX IF NOT EXISTS pt_session_feedback_score
  ON pt_session_feedback (organization_id, score)
  WHERE status = 'submitted';

DROP TRIGGER IF EXISTS trg_pt_session_feedback_updated_at ON pt_session_feedback;
CREATE TRIGGER trg_pt_session_feedback_updated_at
  BEFORE UPDATE ON pt_session_feedback
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Tenant isolation ────────────────────────────────────────────────────────
ALTER TABLE pt_session_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pt_session_feedback FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON pt_session_feedback;
CREATE POLICY deny_all_direct_access ON pt_session_feedback
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON pt_session_feedback;
CREATE POLICY tenant_isolation ON pt_session_feedback FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON pt_session_feedback TO app_tenant;

COMMENT ON TABLE pt_session_feedback IS
  'One feedback request per completed PT session, and the client''s submitted answers (migration 265).';
COMMENT ON COLUMN pt_session_feedback.score IS
  'Weighted 0–5 session score, computed server-side from the five answers and stored at submission time.';
