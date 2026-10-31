-- 246_churn_followups.sql
--
-- The churn-risk screen shows each trainer the clients most likely to leave
-- and lets them log what they did about it. This table is that log: one row
-- per trainer action, newest row wins for display.
--
-- ── Why an append-only log, not a flag on pt_clients ────────────────────────
--
-- `contacted` and `snoozed` are different claims with different lifetimes.
-- "I called them" stays true forever and is the audit trail; "not now, ask me
-- in three weeks" expires on its own. Overwriting one column with the other
-- would lose the first fact, and a snooze that expired cannot be reconstructed
-- from a timestamp if it was overwritten by a contact note.
--
-- ── Why risk_score is stored ────────────────────────────────────────────────
--
-- The score is a snapshot of what the trainer was shown when they acted.
-- Recomputing it at read time would make yesterday's decision look like it was
-- made about today's risk — the history would silently rewrite itself every
-- time the scoring module changed.
--
-- ── The latest row ──────────────────────────────────────────────────────────
--
-- The index below backs the only read: the newest follow-up per client in one
-- organization. It is DESC on created_at so Postgres can answer that with an
-- index scan instead of sorting every row per client.

CREATE TABLE IF NOT EXISTS pt_client_followups (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL,
  client_id       TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  outcome         TEXT NOT NULL CHECK (outcome IN ('contacted','snoozed')),
  hide_until      DATE NOT NULL,
  risk_score      SMALLINT NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pt_client_followups_latest
  ON pt_client_followups (organization_id, client_id, created_at DESC);

-- ── Tenant isolation ────────────────────────────────────────────────────────
-- Same shape as migration 245. New tables do not get to inherit the gap
-- pt_sessions predates.

ALTER TABLE pt_client_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pt_client_followups FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON pt_client_followups;
CREATE POLICY deny_all_direct_access ON pt_client_followups
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON pt_client_followups;
CREATE POLICY tenant_isolation ON pt_client_followups FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON pt_client_followups TO app_tenant;

COMMENT ON TABLE pt_client_followups IS
  'Append-only log of trainer actions on the churn list; the newest row per client wins (migration 246).';
COMMENT ON COLUMN pt_client_followups.outcome IS
  'contacted = logged a real conversation (hides the client for 7 days); snoozed = hide until the caller''s date.';
COMMENT ON COLUMN pt_client_followups.hide_until IS
  'Calendar day the client stays hidden, in studio time. DATE, not a timestamp: the read path compares day strings, and a timestamp shifts the boundary by a timezone. Never NULL — every mark hides.';
COMMENT ON COLUMN pt_client_followups.risk_score IS
  'Risk score shown to the trainer at the moment of the action, 0-100. Snapshot, never recomputed; never NULL, because a mark is only written for a client that was in the scored list.';
