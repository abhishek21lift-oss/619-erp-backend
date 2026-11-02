-- ─────────────────────────────────────────────────────────────────────────
-- 255 — Session length and equipment on the client
-- ─────────────────────────────────────────────────────────────────────────
--
-- The Enrol screen now owns the client's Training Availability section: the
-- same questions the Goal Setting wizard asks, saved against the client rather
-- than only inside a goal. Training mode, preferred time, preferred days,
-- sessions per week and experience already have columns (053 and the client
-- table); these are the two that did not.
--
-- Both are nullable and additive. Every existing row keeps its data and reads
-- these as "not recorded" until a trainer fills them in.
--
-- Idempotent; safe to re-run. No BEGIN/COMMIT — migrate.js wraps this with the
-- _migrations insert.

ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS session_minutes SMALLINT
    CHECK (session_minutes IS NULL OR session_minutes BETWEEN 20 AND 180),
  ADD COLUMN IF NOT EXISTS equipment TEXT
    CHECK (equipment IS NULL OR equipment IN ('full_gym', 'dumbbells', 'bodyweight', 'bands'));

COMMENT ON COLUMN pt_clients.session_minutes IS
  'Planned PT session length in minutes (20-180). The Enrol form offers 30/45/60/75/90.';
COMMENT ON COLUMN pt_clients.equipment IS
  'Equipment the client trains with: full_gym, dumbbells, bodyweight or bands.';
