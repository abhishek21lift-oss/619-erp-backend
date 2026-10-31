-- ============================================================
-- 244_remove_gym_erp_surface.sql
-- The product is a personal-trainer OS. Retire the gym-ERP surface.
-- ============================================================
--
-- Three things happen here, in order:
--
--   1. membership_payments is renamed to pt_payment_activations. The table is
--      not gym data — every column on it is PT (payment_order_id, client_id,
--      pt_payment_id) — it was only named for a membership the product no
--      longer sells. Renaming keeps every activation row and its receipt.
--
--   2. payment_orders.plan_id stops referencing plans(). New orders store a
--      pt_packages id; old orders keep the id as a historical snapshot, which
--      is exactly what that column was for ("kept for reporting only").
--
--   3. The gym-ERP tables move to the `archive` schema with every row intact.
--      Nothing is deleted. See 193/195 for the same convention.
--
-- No BEGIN/COMMIT here: migrate.js wraps each migration in its own
-- transaction (see migrations.transactionControl.test.js).

-- ------------------------------------------------------------
-- 1. Rename the activation ledger
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.membership_payments') IS NOT NULL
     AND to_regclass('public.pt_payment_activations') IS NULL THEN
    ALTER TABLE public.membership_payments RENAME TO pt_payment_activations;
    RAISE NOTICE '244: renamed membership_payments → pt_payment_activations';
  END IF;

  IF to_regclass('public.pt_payment_activations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'membership_payments_window'
                  AND conrelid = 'public.pt_payment_activations'::regclass) THEN
      ALTER TABLE public.pt_payment_activations
        RENAME CONSTRAINT membership_payments_window TO pt_payment_activations_window;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'membership_payments_order_unique'
                  AND conrelid = 'public.pt_payment_activations'::regclass) THEN
      ALTER TABLE public.pt_payment_activations
        RENAME CONSTRAINT membership_payments_order_unique TO pt_payment_activations_order_unique;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'membership_payments_receipt_unique'
                  AND conrelid = 'public.pt_payment_activations'::regclass) THEN
      ALTER TABLE public.pt_payment_activations
        RENAME CONSTRAINT membership_payments_receipt_unique TO pt_payment_activations_receipt_unique;
    END IF;

    IF to_regclass('public.idx_membership_payments_client') IS NOT NULL THEN
      ALTER INDEX public.idx_membership_payments_client
        RENAME TO idx_pt_payment_activations_client;
    END IF;
    IF to_regclass('public.idx_membership_payments_org') IS NOT NULL THEN
      ALTER INDEX public.idx_membership_payments_org
        RENAME TO idx_pt_payment_activations_org;
    END IF;
    IF to_regclass('public.idx_membership_payments_approved_by') IS NOT NULL THEN
      ALTER INDEX public.idx_membership_payments_approved_by
        RENAME TO idx_pt_payment_activations_approved_by;
    END IF;
    IF to_regclass('public.idx_membership_payments_submission_id') IS NOT NULL THEN
      ALTER INDEX public.idx_membership_payments_submission_id
        RENAME TO idx_pt_payment_activations_submission_id;
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.pt_payment_activations IS
  'One row per approved UPI order: the receipt, the payment it produced and the PT term it bought. Named for the PT product; the columns were always client/pt_payment based.';

-- ------------------------------------------------------------
-- 2. Detach payment_orders.plan_id from the gym plans table
-- ------------------------------------------------------------
DO $$
DECLARE con RECORD;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_class tgt ON tgt.oid = c.confrelid
     WHERE c.contype = 'f'
       AND src.relnamespace = 'public'::regnamespace
       AND src.relname = 'payment_orders'
       AND tgt.relnamespace = 'public'::regnamespace
       AND tgt.relname = 'plans'
  LOOP
    EXECUTE format('ALTER TABLE public.payment_orders DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE '244: dropped payment_orders FK % (plans is retired)', con.conname;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Archive the gym-ERP tables
--
--    Group-class booking (class_*/bookings), gym memberships
--    (plans/member_memberships/members), biometric and face check-in,
--    multi-branch and staff leave, and the class-booking Google Calendar
--    sync. `subscriptions`/`renewals` are already dropped by 021/170 on any
--    migrated database; they are listed for the fresh-bootstrap case and are
--    skipped when absent.
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS archive;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'google_calendar_events', 'google_calendar_tokens',
    'bookings', 'class_sessions', 'class_templates',
    'member_memberships', 'members',
    'face_descriptors', 'face_checkin_logs', 'biometric_attendance',
    'leave_requests', 'staff', 'staff_targets',
    'plans', 'branches', 'subscriptions', 'renewals'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA archive', t);
      RAISE NOTICE '244: archived public.%', t;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Verify the end state
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bookings', 'class_sessions', 'class_templates',
    'member_memberships', 'members',
    'face_descriptors', 'face_checkin_logs', 'biometric_attendance',
    'leave_requests', 'plans', 'branches',
    'google_calendar_events', 'google_calendar_tokens'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      RAISE EXCEPTION '244 failed: public.% still exists after the move', t;
    END IF;
    IF to_regclass('archive.' || t) IS NULL THEN
      RAISE EXCEPTION '244 failed: archive.% is missing — the move lost a table', t;
    END IF;
  END LOOP;

  -- The PT side must be untouched.
  IF to_regclass('public.pt_clients') IS NULL THEN
    RAISE EXCEPTION '244 failed: public.pt_clients is missing';
  END IF;
  IF to_regclass('public.pt_packages') IS NULL THEN
    RAISE EXCEPTION '244 failed: public.pt_packages is missing';
  END IF;
  IF to_regclass('public.pt_payment_activations') IS NULL THEN
    RAISE EXCEPTION '244 failed: public.pt_payment_activations is missing';
  END IF;
END $$;
