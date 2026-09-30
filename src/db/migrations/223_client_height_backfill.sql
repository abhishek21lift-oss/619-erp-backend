-- ─────────────────────────────────────────────────────────────────────────
-- 223 — Carry measured height onto the client record
-- ─────────────────────────────────────────────────────────────────────────
--
-- From the member-profile audit. pt_clients.height is what the member's
-- Account page shows, and it was empty for every live client (37 of 37 in
-- production, 2026-09-30) — the row simply never appeared.
--
-- The Fitness assessment has recorded height_cm all along; it only started
-- copying it to the client record in the assessment audit (#202). Four
-- clients were measured before that, and their height sits on the assessment
-- alone. This copies the most recent measured height across, for clients who
-- have none of their own. A height a trainer already typed on the client is
-- never overwritten.
--
-- Idempotent; safe to re-run.

UPDATE pt_clients c
   SET height = latest.height_cm
  FROM (
    SELECT DISTINCT ON (a.client_id) a.client_id, a.organization_id, a.height_cm
      FROM pt_assessments a
     WHERE a.height_cm IS NOT NULL AND a.height_cm BETWEEN 50 AND 272
     ORDER BY a.client_id, a.assessment_date DESC NULLS LAST, a.created_at DESC
  ) latest
 WHERE c.id = latest.client_id
   AND c.organization_id = latest.organization_id
   AND c.height IS NULL
   AND c.deleted_at IS NULL;
