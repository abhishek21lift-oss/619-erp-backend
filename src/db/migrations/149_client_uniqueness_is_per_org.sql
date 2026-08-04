-- 149_client_uniqueness_is_per_org.sql
--
-- Client mobile/email uniqueness was PLATFORM-WIDE, not per studio.
--
--   CREATE UNIQUE INDEX pt_clients_mobile_unique ON pt_clients (mobile);
--
-- No organization_id. So one studio adding a client permanently burned that
-- phone number for every other studio on the platform. Observed in production:
--
--   04:41  "Stuti Yadav"  6387171298  created in Abhishek PT Studio
--   04:51  ADVENTURE PT STUDIO signs in, tries to add the same person
--          -> 23505, "Duplicate entry — this record already exists."
--   04:58  same studio retries with a different number -> succeeds
--
-- From inside ADVENTURE PT STUDIO the client list was empty, so "this record
-- already exists" was not just unhelpful, it was untrue as far as that user
-- could see. It reads as a broken button. The studio owner reasonably blamed
-- the device they were on, because the retry happened to be on another one.
--
-- This is not an edge case. A person who trains at two studios, a shared family
-- number, a couple using one mobile, or the same test number reused during
-- onboarding all hit it. It is also a cross-tenant information leak: the error
-- lets any studio probe whether a phone number or email exists ANYWHERE on the
-- platform, which is a fact about someone else's client list.
--
-- Uniqueness is now scoped to (organization_id, …). Within one studio a
-- duplicate mobile is still rejected, which is the rule that was actually
-- wanted; across studios it is none of their business.
--
-- Two other corrections while replacing these:
--
--   * pt_clients_mobile_unique had no WHERE clause, so two clients with an
--     empty-string mobile collided ('' is not NULL). The clients table already
--     guarded against that; pt_clients did not. Both now exclude '' and NULL.
--   * pt_clients_email_unique compared email verbatim while clients_email_uniq
--     used lower(email). Both now use lower(), so Ravi@x.com and ravi@x.com are
--     the same address everywhere.
--
-- Safe to apply to existing data: the indexes being dropped were STRICTLY
-- stronger than the ones replacing them, so anything that satisfied the global
-- constraint satisfies the per-org one. No duplicates can be waiting.
--
-- NOT touched: users_email_key and trainers_email_uniq. A user's email is their
-- login identity and must stay globally unique; trainers resolve to users, so
-- the same reasoning applies. Only client records are per-studio data.

-- ── pt_clients ───────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS pt_clients_mobile_unique;
DROP INDEX IF EXISTS pt_clients_email_unique;

CREATE UNIQUE INDEX IF NOT EXISTS pt_clients_org_mobile_unique
  ON pt_clients (organization_id, mobile)
  WHERE mobile IS NOT NULL AND mobile <> '';

CREATE UNIQUE INDEX IF NOT EXISTS pt_clients_org_email_unique
  ON pt_clients (organization_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';

-- ── clients (legacy roster) ──────────────────────────────────────────────────
DROP INDEX IF EXISTS clients_mobile_uniq;
DROP INDEX IF EXISTS clients_email_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS clients_org_mobile_uniq
  ON clients (organization_id, mobile)
  WHERE mobile IS NOT NULL AND mobile <> '';

CREATE UNIQUE INDEX IF NOT EXISTS clients_org_email_uniq
  ON clients (organization_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';
