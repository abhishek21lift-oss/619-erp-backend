-- 163_pt_clients_relationship_and_source.sql
-- Two columns for the redesigned new-client intake form.
--
-- ── emergency_contact_relationship ──────────────────────────────────────────
--
-- pt_clients has carried emergency_contact (a name) and emergency_phone (a
-- number) since migration 052, and nothing saying WHO that person is. In an
-- actual emergency "Priya, 98xxxxxxxx" is a phone number the trainer cannot
-- introduce themselves to — mother, spouse and neighbour are three different
-- conversations. The intake form asked for Occupation in this slot instead,
-- which was required and never read by anything downstream.
--
-- Occupation is NOT dropped here. It is still collected by the lifestyle
-- assessment (migration 056) and read by the training brief, so the column
-- stays exactly as it is; it is only the intake form that stops asking for it.
--
-- ── client_source ───────────────────────────────────────────────────────────
--
-- Where the client came from — the one question a studio owner asks about
-- marketing spend and could not answer from this system at all.
--
-- Free TEXT rather than an enum type, with the closed list enforced in
-- pt-os.routes.js (CLIENT_SOURCES) next to the same treatment PAYMENT_METHODS
-- gets. Same reasoning as refresh_tokens.audience in 162: a CHECK constraint
-- means every future option needs a migration deployed strictly before the
-- code that writes it, which turns adding "Facebook" to a dropdown into a
-- release-ordering problem. The values stored are the display labels
-- ('Walk-in', 'Existing Member', …) so a GROUP BY reads as a report.
--
-- Both nullable with no default. Every client already on the roster predates
-- these questions, and inventing 'Other' or 'Unknown' for them would put
-- thousands of rows into a bucket that looks like an answer.

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS emergency_contact_relationship TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS client_source                  TEXT;

COMMENT ON COLUMN pt_clients.emergency_contact_relationship IS
  'How emergency_contact is related to the client (spouse, mother, friend…). '
  'Free text with a suggested list in the UI.';

COMMENT ON COLUMN pt_clients.client_source IS
  'How the client found the studio. One of the labels in CLIENT_SOURCES '
  '(src/modules/pt-os/pt-os.routes.js); NULL for clients onboarded before '
  'the question existed.';
