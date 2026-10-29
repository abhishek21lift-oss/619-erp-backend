-- The last database backup this deployment can prove.
--
-- scripts/backup-database.js verifies its dump with `pg_restore -l` and only
-- then writes this row, so a row means a restorable dump was produced — not
-- that a cron job started. The absence of a row is a real, reportable state:
-- "no verified backup has been recorded", which is not the same as healthy.
CREATE TABLE IF NOT EXISTS platform_backup_status (
  id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_ok_at  TIMESTAMPTZ NOT NULL,
  size_bytes  BIGINT NOT NULL CHECK (size_bytes >= 0),
  tables      INTEGER NOT NULL CHECK (tables >= 0),
  -- FALSE means the dump exists only on the VPS — the same host as the
  -- database it is meant to survive. The card reports that as a warning.
  offsite     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
