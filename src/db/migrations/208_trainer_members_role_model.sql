-- 208_trainer_members_role_model.sql
--
-- The Trainer → Members role model.
--
-- A studio (organization) is one tenant with exactly one owner, the TRAINER,
-- who runs everything inside it; its clients are MEMBERS. The platform
-- operator (super_admin) is not part of any studio. There are no other roles:
-- admin, manager, reception/receptionist and staff are removed.
--
--   users.role ∈ { trainer, member, super_admin }        (no default)
--   trainer, member     → organization_id NOT NULL
--   super_admin         → organization_id NULL
--   one live trainer per organization
--
-- ── Replaces an earlier, never-applied 208 ─────────────────────────────────
--
-- 208_admin_to_trainer_role_consolidation.sql was committed but never ran in
-- production (its CI failed, so the deploy was skipped; production stopped at
-- 207). It is deleted, not amended in place, and this file is written to be
-- correct whether or not that earlier file ran somewhere disposable: every
-- step below is idempotent, and its backup table (_backup_admin_rename) is
-- moved out of `public` if it exists.
--
-- ── Measured before writing (production, 2026-09-22) ───────────────────────
--
--   users: 7 admin (one per organization, all with an organization), 1
--   soft-deleted member, 1 super_admin (no organization); 0 manager,
--   reception, staff or trainer. No RLS policy reads a role. attendance_logs
--   and communication_logs hold only 'client' rows. So the data change is
--   admin → trainer, 1:1 per studio, and nothing else moves.
--
--   One admin has no linked trainer profile, but a live, unlinked profile
--   with the same email exists in their studio (measured 2026-09-23, after
--   the first deployment failed on it — see step 3). It is linked, not copied.
--
-- ── Refuses rather than guesses ────────────────────────────────────────────
--
-- A database whose data does not fit the model — two live staff accounts in
-- one studio, a staff account with no studio, a role nobody recognises — is
-- not "fixed" by picking a winner. The preflight below raises with the count
-- and the reason, the runner rolls the whole file back, and a human decides.
--
-- ── Rollback ───────────────────────────────────────────────────────────────
--
-- Forward-only. archive.role_model_users_backup holds every changed user's
-- previous role, trainer link and token_version, and
-- archive.role_model_settings_backup every removed perm_* setting, so the
-- data half can be restored by hand. Restoring old roles also requires
-- restoring the old users_role_check, which this file replaces.

-- ── 0. Preflight ───────────────────────────────────────────────────────────
DO $$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM users
   WHERE role NOT IN ('super_admin', 'admin', 'manager', 'trainer', 'reception', 'receptionist', 'staff', 'member');
  IF n > 0 THEN
    RAISE EXCEPTION '208: % user(s) hold a role this migration does not recognise; refusing to map them', n;
  END IF;

  SELECT COUNT(*) INTO n FROM users
   WHERE role IN ('admin', 'manager', 'trainer', 'reception', 'receptionist', 'staff', 'member')
     AND organization_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '208: % studio/member account(s) have no organization_id (migration 175 invariant); fix them before the role model can be enforced', n;
  END IF;

  SELECT COUNT(*) INTO n FROM users WHERE role = 'super_admin' AND organization_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '208: % super_admin account(s) belong to an organization; the platform operator must not sit inside a studio', n;
  END IF;

  -- One studio, one trainer. More than one live staff account in a studio
  -- means somebody has to choose the owner; this migration will not.
  SELECT COUNT(*) INTO n FROM (
    SELECT organization_id
      FROM users
     WHERE role IN ('admin', 'manager', 'trainer', 'reception', 'receptionist', 'staff')
       AND deleted_at IS NULL
     GROUP BY organization_id
    HAVING COUNT(*) > 1
  ) multi;
  IF n > 0 THEN
    RAISE EXCEPTION '208: % organization(s) have more than one live staff account; choose each studio''s trainer before migrating', n;
  END IF;

  -- A staff account linked to another studio's trainer profile would carry
  -- that link into the owner role.
  SELECT COUNT(*) INTO n
    FROM users u JOIN trainers t ON t.id = u.trainer_id
   WHERE u.role IN ('admin', 'manager', 'trainer', 'reception', 'receptionist', 'staff')
     AND t.organization_id IS DISTINCT FROM u.organization_id;
  IF n > 0 THEN
    RAISE EXCEPTION '208: % staff account(s) are linked to a trainer profile in a different organization', n;
  END IF;

  -- Step 3 links an unlinked account to the trainer profile that already
  -- carries its email, since trainers_email_uniq (global, soft-deleted rows
  -- included) leaves room for only one. That profile has to be one the
  -- account can own: in its studio, live, and nobody else's.
  SELECT COUNT(*) INTO n
    FROM users u
    JOIN trainers t ON LOWER(t.email) = LOWER(u.email)
   WHERE u.role IN ('admin', 'manager', 'trainer', 'reception', 'receptionist', 'staff')
     AND u.deleted_at IS NULL AND u.trainer_id IS NULL
     AND COALESCE(u.email, '') <> ''
     AND (t.organization_id IS DISTINCT FROM u.organization_id
          OR t.deleted_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM users o WHERE o.trainer_id = t.id));
  IF n > 0 THEN
    RAISE EXCEPTION '208: % unlinked staff account(s) share an email with a trainer profile they cannot own (another studio''s, deleted, or already linked)', n;
  END IF;

  SELECT COUNT(*) INTO n FROM attendance_logs WHERE ref_type NOT IN ('client', 'trainer');
  IF n > 0 THEN
    RAISE EXCEPTION '208: % attendance row(s) are about a staff/user subject that no longer exists as a type', n;
  END IF;

  SELECT COUNT(*) INTO n FROM communication_logs WHERE recipient_type NOT IN ('lead', 'client', 'trainer');
  IF n > 0 THEN
    RAISE EXCEPTION '208: % communication row(s) are addressed to a staff recipient type that no longer exists', n;
  END IF;
END $$;

-- ── 1. Backups, out of `public` ────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS archive;

CREATE TABLE IF NOT EXISTS archive.role_model_users_backup (
  user_id          TEXT        NOT NULL,
  organization_id  UUID,
  old_role         TEXT        NOT NULL,
  old_trainer_id   TEXT,
  old_token_version INT,
  migrated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS archive.role_model_settings_backup (
  organization_id  UUID,
  key              TEXT        NOT NULL,
  value            TEXT,
  migrated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The never-applied 208 created this in public. If it ran anywhere, move it.
DO $$
BEGIN
  IF to_regclass('public._backup_admin_rename') IS NOT NULL THEN
    ALTER TABLE public._backup_admin_rename SET SCHEMA archive;
  END IF;
END $$;

INSERT INTO archive.role_model_users_backup (user_id, organization_id, old_role, old_trainer_id, old_token_version)
SELECT id, organization_id, role, trainer_id, token_version
  FROM users
 WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff');

-- ── 2. Every studio role becomes the trainer ───────────────────────────────
--
-- token_version is bumped so every session minted under the old role — access
-- and refresh token alike — is refused on its next use (auth.js compares the
-- claim on every request). Soft-deleted rows are converted too, because the
-- new CHECK constraint applies to them as well; the unique index below
-- ignores them.
UPDATE users
   SET role = 'trainer',
       token_version = token_version + 1,
       updated_at = NOW()
 WHERE role IN ('admin', 'manager', 'reception', 'receptionist', 'staff');

-- ── 3. Every live trainer has a trainer profile ────────────────────────────
--
-- pt_clients, pt_sessions, pt_payments and QR check-in link to `trainers`,
-- and the studio's trainer checks in as their profile. An owner created
-- before profiles were linked (one production account) is linked now, in
-- their own organization.
--
-- That production owner already HAS a profile — live, in their studio, with
-- their email, just never linked to the account. The first deployment of this
-- file inserted a second one regardless and failed on trainers_email_uniq
-- (rolled back; nothing changed). So an existing profile with the account's
-- email is linked, and a new one is created only when there is none. The
-- preflight has already refused any such profile the account could not own.
DO $$
DECLARE
  r RECORD;
  profile_id TEXT;
BEGIN
  FOR r IN
    SELECT id, name, email, organization_id
      FROM users
     WHERE role = 'trainer' AND deleted_at IS NULL AND trainer_id IS NULL
  LOOP
    profile_id := NULL;
    SELECT t.id INTO profile_id
      FROM trainers t
     WHERE COALESCE(r.email, '') <> ''
       AND LOWER(t.email) = LOWER(r.email)
       AND t.organization_id = r.organization_id
       AND t.deleted_at IS NULL;

    IF profile_id IS NULL THEN
      INSERT INTO trainers (name, email, organization_id)
      VALUES (r.name, r.email, r.organization_id)
      RETURNING id INTO profile_id;
    END IF;

    UPDATE users SET trainer_id = profile_id, updated_at = NOW() WHERE id = r.id;
  END LOOP;
END $$;

-- ── 4. The role column: three values, no default ───────────────────────────
--
-- The DEFAULT 'trainer' is dropped: an INSERT that forgot its role used to
-- create a studio owner. Every insert now has to say what it creates.
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'trainer', 'member'));

-- Studio accounts carry their studio (migration 175's users_tenant_or_platform
-- already says so); the platform operator carries none, which is new.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_platform_role_no_org;
ALTER TABLE users ADD CONSTRAINT users_platform_role_no_org
  CHECK (role <> 'super_admin' OR organization_id IS NULL);

-- One live trainer per studio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_trainer_per_org
  ON users (organization_id)
  WHERE role = 'trainer' AND deleted_at IS NULL;

-- ── 5. Subject/recipient types that named staff ────────────────────────────
ALTER TABLE attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_ref_type_check;
ALTER TABLE attendance_logs ADD CONSTRAINT attendance_logs_ref_type_check
  CHECK (ref_type IN ('client', 'trainer'));

ALTER TABLE communication_logs DROP CONSTRAINT IF EXISTS communication_logs_recipient_type_check;
ALTER TABLE communication_logs ADD CONSTRAINT communication_logs_recipient_type_check
  CHECK (recipient_type IN ('lead', 'client', 'trainer'));

-- ── 6. Platform announcements address trainers and members ─────────────────
ALTER TABLE platform_announcements ALTER COLUMN audience_roles SET DEFAULT ARRAY['trainer']::text[];
UPDATE platform_announcements
   SET audience_roles = COALESCE(
         (SELECT array_agg(DISTINCT CASE WHEN r IN ('admin', 'manager', 'reception', 'receptionist', 'staff')
                                         THEN 'trainer' ELSE r END)
            FROM unnest(audience_roles) AS r
           WHERE r IN ('admin', 'manager', 'reception', 'receptionist', 'staff', 'trainer', 'member')),
         ARRAY['trainer']::text[])
 WHERE audience_roles && ARRAY['admin', 'manager', 'reception', 'receptionist', 'staff']::text[];

-- ── 7. The per-role permission matrix ──────────────────────────────────────
--
-- perm_trainer_* / perm_reception_* decided what staff roles could reach.
-- With one trainer who owns the studio there is nothing left to grant, and the
-- routes that read them are gone. Backed up, then removed.
INSERT INTO archive.role_model_settings_backup (organization_id, key, value)
SELECT organization_id, key, value FROM system_settings WHERE key LIKE 'perm\_%';
DELETE FROM system_settings WHERE key LIKE 'perm\_%';

-- ── 8. Verify ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM users WHERE role NOT IN ('super_admin', 'trainer', 'member');
  IF n > 0 THEN RAISE EXCEPTION '208 verify: % user(s) still hold a removed role', n; END IF;

  SELECT COUNT(*) INTO n FROM users
   WHERE role = 'trainer' AND deleted_at IS NULL AND trainer_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '208 verify: % live trainer(s) without a trainer profile', n; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role' AND column_default IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION '208 verify: users.role still has a default'; END IF;

  RAISE NOTICE '208: % trainer(s), % member(s), % platform operator(s)',
    (SELECT COUNT(*) FROM users WHERE role = 'trainer' AND deleted_at IS NULL),
    (SELECT COUNT(*) FROM users WHERE role = 'member' AND deleted_at IS NULL),
    (SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND deleted_at IS NULL);
END $$;
