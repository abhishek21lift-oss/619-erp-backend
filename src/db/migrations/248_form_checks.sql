-- 248_form_checks.sql
--
-- Asynchronous form review. A member records a lift on their phone, the
-- trainer watches it and leaves comments pinned to the seconds they are about
-- it, then marks it reviewed. This is the coaching loop that used to require
-- both people to be in the same room at the same time.
--
-- ── Why comments are their own table ────────────────────────────────────────
--
-- One review is several observations at different points in the video ("knee
-- tracks in at 0:12", "good depth at 0:31"). A single free-text column would
-- lose the timestamps, and a JSON blob would lose ordering and make one
-- comment impossible to point at. Rows with at_seconds are the smallest shape
-- that preserves what the coach actually said and when.
--
-- ── Status ─────────────────────────────────────────────────────────────────
--
-- 'reviewed' is the trainer's explicit claim, not "has a comment". The queue
-- is a to-do list; a half-written thought should not remove the item from it.
-- reviewed_at is kept beside the status so the history survives even if the
-- status is ever changed by hand.

CREATE TABLE IF NOT EXISTS pt_form_checks (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  client_id       TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  exercise        TEXT NOT NULL,
  note            TEXT,
  video_url       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

-- The trainer's queue, and the member's own history, are the only two reads.
CREATE INDEX IF NOT EXISTS pt_form_checks_queue
  ON pt_form_checks (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS pt_form_checks_client
  ON pt_form_checks (organization_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pt_form_check_comments (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  form_check_id   TEXT NOT NULL REFERENCES pt_form_checks(id) ON DELETE CASCADE,
  at_seconds      INTEGER NOT NULL CHECK (at_seconds >= 0),
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read in video order so the member hears the review in the order they watch.
CREATE INDEX IF NOT EXISTS pt_form_check_comments_thread
  ON pt_form_check_comments (form_check_id, at_seconds, created_at);

-- ── Tenant isolation ────────────────────────────────────────────────────────
-- Same shape as migration 246: deny direct access, then let app_tenant see
-- only rows for the organization in the request context.

ALTER TABLE pt_form_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pt_form_checks FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON pt_form_checks;
CREATE POLICY deny_all_direct_access ON pt_form_checks
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON pt_form_checks;
CREATE POLICY tenant_isolation ON pt_form_checks FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON pt_form_checks TO app_tenant;

ALTER TABLE pt_form_check_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pt_form_check_comments FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON pt_form_check_comments;
CREATE POLICY deny_all_direct_access ON pt_form_check_comments
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON pt_form_check_comments;
CREATE POLICY tenant_isolation ON pt_form_check_comments FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON pt_form_check_comments TO app_tenant;

COMMENT ON TABLE pt_form_checks IS
  'A member''s uploaded lift video and the trainer''s review state (migration 248).';
COMMENT ON COLUMN pt_form_checks.video_url IS
  'Saved through lib/fileStorage.js as /uploads/form-checks/<id>.<ext>; /uploads serves it with HTTP Range so the player can seek.';
COMMENT ON TABLE pt_form_check_comments IS
  'Trainer comments pinned to a second in the form-check video (migration 248).';
COMMENT ON COLUMN pt_form_check_comments.at_seconds IS
  'Video position in whole seconds; 0 starts the clip. Never NULL — an unpinned comment has no place to seek to.';
