-- ============================================================
-- 204_leave_type_personal.sql
--
-- "Personal" was offered everywhere except the one place that decides.
--
-- `leave_requests.leave_type` has carried this CHECK since 001_v4_upgrade.sql,
-- restated unchanged in 002a_leave_upgrade.sql:
--
--     CHECK (leave_type IN ('sick','casual','earned','emergency','unpaid','other'))
--
-- Six values. Meanwhile `src/routes/leave.js` validates against SEVEN —
--
--     const VALID_LEAVE_TYPES =
--       ['sick','casual','personal','earned','unpaid','emergency','other'];
--
-- — and the leave page's dropdown offers the same seven. So a trainer picking
-- "Personal", which is the natural choice for the very example the Reason box
-- suggests ("personal emergency"), passed the browser, passed the route's own
-- validation, and then hit this constraint on the INSERT. The result is a
-- Postgres error surfacing as a 500: no field marked, nothing to correct, and
-- a perfectly ordinary request that simply cannot be filed.
--
-- ── Which side is wrong ─────────────────────────────────────────────────
--
-- The constraint. Two independent places — the route and the UI — were
-- deliberately written to accept `personal`, and nothing anywhere argues for
-- excluding it; the value was added to both after 001 and the constraint was
-- simply not updated with them. Widening it makes the database agree with the
-- intent already expressed twice, and changes no business logic: no existing
-- row can violate the new constraint, because the new set is a strict
-- superset of the old one.
--
-- The alternative — dropping `personal` from the route and the dropdown —
-- would remove a category studios plainly want, to preserve a line nobody
-- meant to be the authority.
--
-- `leaveTypeVocabulary.test.js` pins the three lists against each other from
-- here on, so the next value cannot be added to two of them.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_leave_type_check'
  ) THEN
    ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_leave_type_check;
  END IF;

  ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_leave_type_check
    CHECK (leave_type IN ('sick','casual','personal','earned','emergency','unpaid','other'));
END $$;
