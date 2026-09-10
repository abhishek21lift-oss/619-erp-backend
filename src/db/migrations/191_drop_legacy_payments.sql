-- ============================================================
-- 191_drop_legacy_payments.sql
-- Retire the legacy `payments` ledger. pt_payments is canonical.
-- ============================================================
--
-- ── Why this table goes ─────────────────────────────────────────────────────
--
-- `payments` has no organization_id column. Not "is missing a filter" — there
-- is nothing to filter ON, so every row it could hold is unattributable to a
-- studio and unreachable by any tenant-scoped read. In a multi-tenant system
-- that is not a legacy table, it is a hole with a schema.
--
-- pt_payments is the ledger the application actually uses: organization_id on
-- every row, 26 rows and ₹535,500 in production at the time of writing, all of
-- it CASH or UPI. `payments` holds 0 rows and has since the PT-OS enrolment
-- flow shipped.
--
-- Every reader and writer was removed first, in the commit that carries this
-- migration:
--
--   routes/payments.js        UNION ALL over both ledgers → pt_payments only.
--                             The legacy half selected `NULL::uuid AS
--                             organization_id`, so it sat behind a tenant
--                             filter it could never satisfy.
--   routes/payments.js        DELETE/UPDATE fallback with no org clause.
--   routes/invoices.js        INSERT of an unscopable payment row on invoice
--                             settlement → pt_payments, org stamped from the
--                             invoice.
--   routes/trainers.js        6-month revenue trend read the empty table, so
--                             the chart was a flat zero → pt_payments.
--   routes/razorpay-webhook.js  three UPDATEs naming gateway_payment_id and
--                             refund_id, neither of which exists on this
--                             table. Every gateway event raised, was caught,
--                             and was answered 200. Removed.
--   workers/renewal.worker.js INSERT keyed on member_id, for the gym-era
--                             membership model whose tables hold 0 rows.
--   routes/admin-reset.js     reset sweep entry.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
--
-- The table is empty, so recreating it loses nothing. Its full definition as
-- it stood is preserved at the bottom of this file, commented, together with
-- its indexes and the invoices FK, so the structure can be restored exactly.
-- There is no data to restore.
--
-- ── No BEGIN/COMMIT here, deliberately ──────────────────────────────────────
--
-- migrate.js already wraps every migration in a transaction together with the
-- `INSERT INTO _migrations` that records it as applied, so the DDL and its
-- bookkeeping commit together or not at all. A migration that opens its own
-- transaction closes the runner's early — the row recording the migration then
-- runs outside any transaction, and a failure there leaves the change applied
-- with the runner unaware, so it runs again on the next boot. Enforced by
-- migrations.transactionControl.test.js, which caught exactly that here.

-- ------------------------------------------------------------
-- 1. Refuse to run if anything ever landed in this table.
--
--    The whole argument for dropping rather than migrating is that the table
--    is empty. If that stops being true between writing this and running it,
--    this migration is wrong and must fail loudly rather than destroy money.
-- ------------------------------------------------------------
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public.payments') IS NULL THEN
    RAISE NOTICE '191: payments already absent — nothing to do';
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM public.payments' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      '191 refused: public.payments holds % row(s). This migration only drops an EMPTY legacy ledger. Migrate those rows into pt_payments (with an organization_id) before re-running.', n;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. The dependent view.
--
--    v_trainer_monthly_revenue aggregates trainer revenue from this table. No
--    code reads it and no migration created it, so it is dropped rather than
--    rebuilt: it also has no organization_id anywhere in its definition, so a
--    rebuild on pt_payments would be a new cross-tenant aggregate. Trainer
--    revenue is served by routes/trainers.js, which is org-scoped through the
--    trainer it has already resolved.
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.v_trainer_monthly_revenue;

-- ------------------------------------------------------------
-- 3. Repoint the invoice → payment link at the canonical ledger.
--
--    invoices.payment_id has always carried a foreign key to `payments`, and
--    nothing ever wrote it. The column stays and the key now points at
--    pt_payments; routes/invoices.js fills it when an invoice is marked paid,
--    so "which payment settled this invoice" becomes answerable rather than
--    merely modelled.
--
--    Safe on any database: invoices holds 0 rows in production, and any row
--    that did exist would have payment_id NULL, since nothing populated it.
--
--    ── The column is ADDED first, and that is not belt-and-braces ──────────
--
--    production's invoices carries payment_id; a database built from
--    schema.sql + migrations does NOT. Pre-existing drift, found by
--    bootstrapping this migration rather than by reading. Left alone it would
--    mean routes/invoices.js — which now writes this column — works in
--    production and raises `column "payment_id" does not exist` on every fresh
--    install and in CI. Adding it here converges the two shapes, which is the
--    only state in which one codebase can serve both.
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS public.invoices
  DROP CONSTRAINT IF EXISTS invoices_payment_id_fkey;

DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL THEN
    ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS payment_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('public.invoices') IS NOT NULL
     AND to_regclass('public.pt_payments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='invoices'
                    AND column_name='payment_id') THEN
    -- Any stale value would dangle against the new parent, and there cannot be
    -- one — but assert it rather than assume it.
    UPDATE public.invoices i SET payment_id = NULL
     WHERE i.payment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.pt_payments p WHERE p.id = i.payment_id);

    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_payment_id_fkey
      FOREIGN KEY (payment_id) REFERENCES public.pt_payments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Any other inbound foreign key.
--
--    Resolved from pg_catalog rather than named, so the set is whatever the
--    database actually holds and cannot drift from this file. A fresh
--    bootstrap and a prod-shaped database differ here, and both must work.
-- ------------------------------------------------------------
DO $$ DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS tbl
      FROM pg_constraint con
      JOIN pg_class tc ON tc.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = tc.relnamespace
     WHERE n.nspname = 'public' AND tc.relname = 'payments' AND con.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 5. Drop it.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public.payments;
DROP SEQUENCE IF EXISTS public.payments_id_seq;

-- ------------------------------------------------------------
-- 6. Prove it.
-- ------------------------------------------------------------
DO $$ BEGIN
  IF to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION '191 failed: public.payments still exists after the drop';
  END IF;
  IF to_regclass('public.pt_payments') IS NULL THEN
    RAISE EXCEPTION '191 failed: pt_payments is missing — the canonical ledger must exist';
  END IF;
  -- The invoice linkage must point at the canonical ledger, on every shape of
  -- database. Asserted rather than assumed: the ADD COLUMN above exists
  -- because a fresh build and production disagreed about this column.
  IF to_regclass('public.invoices') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'invoices_payment_id_fkey'
          AND confrelid = 'public.pt_payments'::regclass) THEN
    RAISE EXCEPTION '191 failed: invoices.payment_id does not reference pt_payments';
  END IF;
END $$;

-- ── Rollback ────────────────────────────────────────────────────────────────
--
-- The table's full definition — columns, indexes and the invoices foreign key
-- as they stood — is preserved in 191_drop_legacy_payments.ROLLBACK.md beside
-- this file. It lives in a .md rather than in a comment down here for a
-- concrete reason: architecture.domains.convention.test.js builds the schema's
-- table list by scanning every .sql in order for CREATE/DROP, and it does not
-- strip comments. A commented CREATE TABLE after this DROP reads to that scan
-- as the table being recreated, and the manifest check then reports `payments`
-- as an unowned table. Keeping executable files executable is the fix.
