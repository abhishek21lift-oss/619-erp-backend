-- 140_subscription_payment_dedup.sql
--
-- Studios were getting two invoices for one transaction. Every OTHER payment
-- path in this system (a member paying a studio via migration 112, a studio
-- paying the platform via self-checkout via migration 113) has a partial
-- unique index that turns a repeated reference/UTR into a clean 409 instead
-- of a second payment row. The one path that never got this treatment is the
-- super admin's manual "Record Payment" action
-- (POST /organizations/:id/subscription/activate → lib/subscription.js
-- activate()) — a double click, a page refresh that resubmits, or an
-- operator recording the same UPI reference twice all sailed straight
-- through and minted a second subscription_payments row plus a second
-- subscription_invoices row off the back of it.
--
-- Scoped to the organization (not platform-wide): this is a studio's own
-- billing history, not a shared UTR pool, so it matches migration 112's
-- scoping rather than 113's.
--
-- Only 'paid' rows participate. A refunded payment's reference is void, so
-- reusing that same reference for a genuine new charge must not be blocked.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sub_payments_live_reference
  ON subscription_payments (organization_id, reference)
  WHERE reference IS NOT NULL AND status = 'paid';
