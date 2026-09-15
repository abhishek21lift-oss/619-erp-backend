-- integrations.api_key held live third-party secrets that nothing ever read.
--
-- ── What was there ─────────────────────────────────────────────────────────
--
-- `POST /api/integrations/:id/connect` wrote the value of a free-text "API Key
-- / Webhook URL" field straight into `integrations.api_key` (TEXT, no
-- encryption) and flipped the row to 'connected'. The preceding "Test
-- Connection" never contacted the provider — it asserted the string started
-- with 'rzp_' / 'sk_' / 'SG.' and returned success — so the UI went green for
-- any correctly-shaped input.
--
-- No code path in this repository has ever SELECTed api_key. Razorpay, the one
-- provider that works, reads RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from the
-- environment in lib/razorpay.js. The column was therefore pure liability:
-- a studio owner's live payment secret, at rest in plaintext, powering nothing.
--
-- ── What this does ─────────────────────────────────────────────────────────
--
-- Clears every stored key, and demotes the rows whose 'connected' status was
-- only ever a claim about that key. Rows are kept rather than deleted so a
-- studio still sees its own history, and so this is reversible in the only
-- direction that matters: re-entering a credential once a provider is really
-- wired up.
--
-- Deliberately NOT dropping the column. Dropping it is a one-way change on a
-- live table, and the honest status this replaces it with is delivered by the
-- route (routes/integrations.js, PROVIDERS), not by the schema. A later
-- migration can drop it once no deployed backend references the column.
--
-- Idempotent: re-running clears nothing further and re-demotes nothing.

UPDATE integrations
   SET api_key    = NULL,
       status     = CASE WHEN status = 'connected' THEN 'disconnected' ELSE status END,
       updated_at = NOW()
 WHERE api_key IS NOT NULL;

COMMENT ON COLUMN integrations.api_key IS
  'Unused. Scrubbed by migration 203; the connect flow that wrote it was removed. '
  'Server-driven providers read their credentials from the environment. '
  'Do not write secrets here — nothing reads them.';
