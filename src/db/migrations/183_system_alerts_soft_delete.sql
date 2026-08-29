-- 183_system_alerts_soft_delete.sql
-- Add deleted_at column to system_alerts for soft-delete support.

ALTER TABLE system_alerts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Create index for soft-delete filtering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS system_alerts_deleted_at_idx
  ON system_alerts (deleted_at);