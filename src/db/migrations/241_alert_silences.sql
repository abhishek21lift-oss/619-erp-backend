-- 241_alert_silences.sql
--
-- Planned maintenance, and the "we know, stop paging us" window.
--
-- ── Silence is not acknowledge ──────────────────────────────────────────────
--
-- Acknowledging says "somebody has this alert". Silencing says "do not announce
-- anything about this source until the window closes". The condition is still
-- detected, the alert still opens and still appears in the console — what stops
-- is the notification. Losing detection would mean the maintenance itself hides
-- a NEW failure, which is the exact failure mode a maintenance window must not
-- introduce.
--
-- `source` NULL means every source. The window is bounded at creation (5 min ..
-- 30 days) and cancel is recorded separately from `ends_at`, so history shows
-- the window that was planned rather than the moment somebody gave up.

CREATE TABLE IF NOT EXISTS alert_silences (
  id             BIGSERIAL PRIMARY KEY,
  source         TEXT,                    -- NULL = all sources
  reason         TEXT NOT NULL,
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at        TIMESTAMPTZ NOT NULL,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   TEXT,
  CONSTRAINT alert_silences_window CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS alert_silences_active
  ON alert_silences (ends_at)
  WHERE cancelled_at IS NULL;

-- Platform data, deny-all: a studio cannot silence the operator's alerts, and
-- has no business reading the maintenance calendar either.
ALTER TABLE alert_silences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON alert_silences FROM anon, authenticated;

DROP POLICY IF EXISTS deny_all_direct_access ON alert_silences;
CREATE POLICY deny_all_direct_access ON alert_silences
  FOR ALL USING (false) WITH CHECK (false);
