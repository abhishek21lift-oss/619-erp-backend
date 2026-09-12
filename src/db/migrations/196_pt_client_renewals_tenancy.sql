-- ============================================================
-- 196_pt_client_renewals_tenancy.sql
-- Give the renewal ledger a tenant and a referent.
-- ============================================================
--
-- `pt_client_renewals` is the only record of a renewal decision — who renewed,
-- what their old term ended, what the new one runs to. A true renewal-
-- conversion rate is built on it (modules/insights/definitions.js), which is
-- what prompted looking at it closely.
--
-- Migration 048 created it with a primary key and nothing else:
--
--   no organization_id  → it cannot be scoped to a studio at all; every
--                         reader must join pt_clients to find out whose
--                         renewal it was (routes/ai.js:1327 does exactly
--                         this, and says so).
--   no foreign key      → a renewal row outlives the client it describes.
--
-- Both consequences are already in production. Measured before this
-- migration:
--
--   pt_client_renewals            6 rows
--   …whose client_id has no pt_clients row at all   5
--   …attributable to a studio                       1
--
-- Five renewal events survived a hard delete of their client. They record
-- real money — ₹22,500, ₹65,000, ₹10,000 among them — and they belong to
-- nobody. No org-scoped query can ever return them, so they are invisible to
-- every studio's reports while still sitting in the table.
--
-- ── What this does, and what it deliberately does not ───────────────────────
--
-- Adds the column, backfills what can be attributed, indexes it, and adds the
-- foreign key as NOT VALID so the constraint binds every future row without
-- failing on the five that already violate it.
--
-- It does NOT delete the orphans. They are the only surviving evidence of
-- those renewals, and a migration is not the place to decide that a studio's
-- payment history is disposable. They stay, with organization_id NULL, which
-- is now a queryable marker for "unattributable" rather than a fact hidden
-- behind a join. The report at the end names the count so it cannot be
-- overlooked.
--
-- It does NOT add NOT NULL to organization_id, for the same reason — that
-- would require either deleting the orphans or inventing a studio for them.
--
-- ── No BEGIN/COMMIT here, deliberately ─────────────────────────────────────
--
-- migrate.js wraps every migration together with the `INSERT INTO _migrations`
-- that records it. A migration that opens its own transaction closes the
-- runner's early. Enforced by migrations.transactionControl.test.js.

-- ------------------------------------------------------------
-- 1. The column.
-- ------------------------------------------------------------
ALTER TABLE pt_client_renewals
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 2. Backfill from the client the renewal belongs to.
--
--    Only rows whose client still exists can be attributed; the rest keep
--    NULL. Idempotent — re-running attributes anything that has since become
--    attributable and rewrites nothing that already is.
-- ------------------------------------------------------------
UPDATE pt_client_renewals r
   SET organization_id = c.organization_id
  FROM pt_clients c
 WHERE c.id = r.client_id
   AND r.organization_id IS DISTINCT FROM c.organization_id
   AND c.organization_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Index the column readers will filter on.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS pt_client_renewals_org_idx
  ON pt_client_renewals (organization_id, renewed_at DESC);

-- Renewal conversion windows on the END DATE of the term being renewed, not
-- on when the renewal was keyed in, so that is the column the metric sorts and
-- filters by.
CREATE INDEX IF NOT EXISTS pt_client_renewals_old_end_idx
  ON pt_client_renewals (old_end_date)
  WHERE old_end_date IS NOT NULL;

-- ------------------------------------------------------------
-- 4. The foreign key, NOT VALID.
--
--    NOT VALID means: enforce on every INSERT and UPDATE from now on, do not
--    check the rows already there. That is exactly the shape of this problem
--    — the five orphans cannot satisfy it and must not be destroyed to make
--    it pass. A later migration can run `VALIDATE CONSTRAINT` once somebody
--    has decided what those five rows are.
--
--    ON DELETE SET NULL rather than CASCADE: deleting a client must not
--    silently erase the record that they once renewed. That is how these five
--    became orphans in the first place — except that without the constraint,
--    client_id kept pointing at a row that no longer existed, which is worse
--    than NULL because it looks like a working reference.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'pt_client_renewals'::regclass
       AND conname  = 'pt_client_renewals_client_id_fkey'
  ) THEN
    ALTER TABLE pt_client_renewals
      ADD CONSTRAINT pt_client_renewals_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE SET NULL
      NOT VALID;
    RAISE NOTICE '196: client_id foreign key added NOT VALID (binds new rows only)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 5. Report the end state rather than assume it.
-- ------------------------------------------------------------
DO $$
DECLARE total BIGINT; attributed BIGINT; orphaned BIGINT;
BEGIN
  SELECT count(*) INTO total FROM pt_client_renewals;
  SELECT count(*) INTO attributed FROM pt_client_renewals WHERE organization_id IS NOT NULL;
  SELECT count(*) INTO orphaned FROM pt_client_renewals r
    WHERE NOT EXISTS (SELECT 1 FROM pt_clients c WHERE c.id = r.client_id);

  RAISE NOTICE '196: % renewal row(s); % attributed to a studio; % orphaned and kept',
    total, attributed, orphaned;

  IF orphaned > 0 THEN
    RAISE WARNING '196: % renewal row(s) reference a client that no longer exists. They are preserved with organization_id NULL and are invisible to every studio-scoped report. Decide what they are before running VALIDATE CONSTRAINT on pt_client_renewals_client_id_fkey.', orphaned;
  END IF;
END $$;

COMMENT ON COLUMN pt_client_renewals.organization_id IS
  'The studio this renewal belongs to, copied from the client at write time. '
  'NULL means unattributable — the client row is gone. Such rows are excluded '
  'from every scoped report by construction.';
