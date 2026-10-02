-- ─────────────────────────────────────────────────────────────────────────
-- 224 — Clear the PT start date that client creation invented
-- ─────────────────────────────────────────────────────────────────────────
--
-- POST /api/pt-os/clients used to default pt_start_date to "today" for every
-- new client, including a bare add with no package. The client profile read
-- that date as "enrolled" and offered Renew PT to people who had never had a
-- term. The code no longer does either (lib/ptTerm.js decides from the end
-- date and the term history), so this is cleanup, not the fix: it stops the
-- invented date being shown as a start date, pre-filled on the Enroll screen,
-- or counted as a "new member" start in reports.
--
-- Only a row with NO trace of a term is touched — every one of these must hold:
--   * status is still 'pending' (never promoted by an enrollment)
--   * no end date, no duration, no price, nothing paid, nothing owed
--   * no renewal, no subscription-history row, no payment
-- Such a row's start date describes nothing. Money, balances, history and
-- every enrolled or once-enrolled client are untouched; joining_date (the
-- sign-up day) is untouched.
--
-- Idempotent; safe to re-run.

UPDATE pt_clients c
   SET pt_start_date = NULL,
       updated_at    = NOW()
 WHERE c.deleted_at IS NULL
   AND c.status = 'pending'
   AND COALESCE(c.pt_start_date::TEXT, '') <> ''
   AND COALESCE(c.pt_end_date::TEXT, '') = ''
   AND COALESCE(c.duration_months, 0) = 0
   AND COALESCE(c.final_amount, 0) = 0
   AND COALESCE(c.paid_amount, 0) = 0
   AND COALESCE(c.balance_amount, 0) = 0
   AND NOT EXISTS (SELECT 1 FROM pt_client_renewals r WHERE r.client_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM pt_client_subscriptions s WHERE s.client_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM pt_payments p WHERE p.client_id = c.id);
