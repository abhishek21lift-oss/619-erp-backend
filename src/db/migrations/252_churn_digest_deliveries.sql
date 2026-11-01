-- 252_churn_digest_deliveries.sql
--
-- One row per studio per day: the claim that the daily at-risk digest was
-- attempted. The unique (organization_id, digest_date) is the exactly-once
-- mechanism — two replicas sweeping at the same time both try the insert and
-- only one gets a row back, so only one sends.
--
-- A failed send keeps its row. The digest is a daily nudge, not a debt: the
-- next day's pass is a better retry than three attempts an hour apart.
--
-- Delivery detail (which channel succeeded) is not stored here. It already
-- lands in notification_log, per channel, from the notification service.

CREATE TABLE IF NOT EXISTS churn_digest_deliveries (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  digest_date     DATE NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  client_count    INTEGER NOT NULL DEFAULT 0 CHECK (client_count >= 0),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, digest_date)
);

ALTER TABLE churn_digest_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON churn_digest_deliveries FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON churn_digest_deliveries;
CREATE POLICY deny_all_direct_access ON churn_digest_deliveries
  FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS tenant_isolation ON churn_digest_deliveries;
CREATE POLICY tenant_isolation ON churn_digest_deliveries FOR ALL TO app_tenant
  USING (organization_id::text = current_setting('app.org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.org_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON churn_digest_deliveries TO app_tenant;

COMMENT ON TABLE churn_digest_deliveries IS
  'Daily at-risk digest claim per studio; the unique (organization_id, digest_date) row is the exactly-once mechanism (migration 252).';
