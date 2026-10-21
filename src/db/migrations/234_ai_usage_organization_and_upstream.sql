-- 234_ai_usage_organization_and_upstream.sql
--
-- Phase-4 remediation (AI audit S-4 + S-5, plus ingest idempotency). Three
-- facts a usage row was missing:
--
-- organization_id — the studio the spend belongs to, resolved from the
--     authenticated context at write time (never from anything the frontend
--     or the model said). Historical rows keep NULL, and NULL means exactly
--     what it says: attribution for those is re-derivable only through the
--     user join, which is where quota and reporting queries still look
--     (COALESCE(l.organization_id, u.organization_id) = org).
--
--     Deliberately NO backfill. Stamping every old row with the owner's
--     CURRENT organization would rewrite a transferred trainer's history
--     into their new studio — the exact bug this column exists to stop.
--     Unknown stays unknown; new rows are exact from here on.
--
-- routed_via — the upstream the gateway itself named (X-Routed-Via, where the
--     gateway provides it). NULL = the gateway did not say. Never a guess:
--     `provider` names the configured endpoint (checkable at insert time),
--     this names what answered behind it when that is knowable.
--
-- One (request_id, user_id) is one row. The mps-ai assistant reports one row
-- per turn keyed by its requestId; a retried or replayed ingest of the same
-- turn now hits the index instead of counting the tokens twice. The clause is
-- partial on request_id: the ERP's own rows leave it NULL (multiple NULLs are
-- fine), so nothing else that writes the ledger is affected.

ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS routed_via TEXT;

CREATE INDEX IF NOT EXISTS ai_usage_org_idx ON ai_usage_log(organization_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_request_key
  ON ai_usage_log(request_id, user_id)
  WHERE request_id IS NOT NULL;
