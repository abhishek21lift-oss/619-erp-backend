-- 119_pt_leads.sql
-- Lead pipeline: prospective clients captured before they enrol in PT.
-- Deliberately independent of pt_clients until conversion — a lead is not
-- a client yet, so it doesn't consume a plan seat or show up in the roster.
-- converted_client_id links back once a lead becomes an actual client.
--
-- id/client-FK types follow the convention used everywhere else pt_clients
-- is referenced (TEXT — see pt_informed_consent, pt_parq_forms, pt_workout_
-- sessions, etc.), not the INTEGER used in migration 048's
-- pt_client_subscriptions/pt_client_renewals — those two are the outlier,
-- not the pattern to match.

CREATE TABLE IF NOT EXISTS pt_leads (
  id                  TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  organization_id     UUID         REFERENCES organizations(id) ON DELETE SET NULL,
  name                TEXT         NOT NULL,
  mobile              TEXT,
  email               TEXT,
  source              TEXT         NOT NULL DEFAULT 'other',
  status              TEXT         NOT NULL DEFAULT 'new',
  interested_package  TEXT,
  trainer_id          TEXT,
  trainer_name        TEXT,
  follow_up_date      DATE,
  notes               TEXT,
  converted_client_id TEXT         REFERENCES pt_clients(id) ON DELETE SET NULL,
  converted_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_leads_organization ON pt_leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_pt_leads_status        ON pt_leads(status);
CREATE INDEX IF NOT EXISTS idx_pt_leads_created_at    ON pt_leads(created_at);
