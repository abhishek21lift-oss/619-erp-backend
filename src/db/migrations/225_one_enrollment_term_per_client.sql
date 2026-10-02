-- ─────────────────────────────────────────────────────────────────────────
-- 225 — At most one enrolment term per client
-- ─────────────────────────────────────────────────────────────────────────
--
-- PATCH /api/pt-os/clients/:id writes a client's FIRST term into
-- pt_client_subscriptions (source = 'enrollment') when it sees none. That
-- check-then-insert ran unlocked, so two saves of one enrolment in flight
-- together could both see "no term yet" and write two. The route now does it
-- inside one transaction with the client row locked FOR UPDATE; this index is
-- the database's own guarantee of the same rule, so the INSERT's existing
-- ON CONFLICT DO NOTHING has a conflict to act on.
--
-- Only 'enrollment' rows are constrained. Renewals and UPI purchases write
-- one row per term on purpose and are untouched.
--
-- Safe to roll out: it adds an index and changes no data. If duplicates
-- already exist (none did in production when this was written), it does NOT
-- delete or merge them — financial history is never rewritten by a
-- migration. It skips the index and says so, and the route's row lock still
-- prevents new duplicates. Idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pt_client_subscriptions
     WHERE source = 'enrollment'
     GROUP BY client_id HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '225: duplicate enrollment terms exist; index not created. Review them by hand.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS pt_client_subs_one_enrollment_idx
      ON pt_client_subscriptions (client_id)
      WHERE source = 'enrollment';
  END IF;
END $$;
