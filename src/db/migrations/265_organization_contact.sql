-- ============================================================================
-- 265_organization_contact.sql
--
-- Studio contact details — what a member sees in their profile hub.
--
-- ── Why free text ───────────────────────────────────────────────────────────
--
-- A member needs three things from the studio: a number to call, an address to
-- walk to, and when somebody is there. `hours` is deliberately not a structured
-- schedule — a studio writes "Mon–Sat 6am–9pm" and the member reads it. Parsing
-- that into per-day rows would invent a contract with the studio that nothing
-- in the product needs yet.
--
-- Additive and nullable. Idempotent; safe to re-run.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS phone   TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS hours   TEXT;

COMMENT ON COLUMN organizations.hours IS
  'Free-text opening hours shown to members. Not a structured schedule.';
