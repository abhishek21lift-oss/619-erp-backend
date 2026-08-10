-- 159_settings_tenant_scope.sql
--
-- AUD-001 (P0). `system_settings` and `feature_flags` are a single global
-- key/value store shared by every studio on the platform.
--
-- ── What that means in production, today ────────────────────────────────────
--
-- Six live studios read the same 35 rows. Those rows hold ONE studio's name,
-- its owner's email address, their mobile number, their street location and the
-- GPS coordinates of their check-in geofence. Every other studio's admin can
-- read all of it from the ordinary Settings screen, and — because PUT
-- /api/settings upserts by key with no organization predicate — overwrite it
-- for everyone. Changing a studio name changes all six. Moving a geofence moves
-- all six. The sixteen `perm_*` role toggles are in here too, so one studio's
-- admin decides what every other studio's trainers may see.
--
-- This migration makes the store per-organization. It is the schema half; the
-- application half is in routes/settings.js and lib/settingsSchema.js.
--
-- ── Why the primary-key swap is in THIS file and not a later one ────────────
--
-- It was planned as a separate migration so this one could be observed alone.
-- That does not survive contact with the constraint: the primary key is
-- `(key)`, so a second organization cannot hold a row for a key another
-- organization already has. The per-org seed below is impossible until the key
-- becomes `(organization_id, key)`. Splitting them would leave an intermediate
-- state where five studios still have no settings of their own — which is the
-- state this migration exists to end.
--
-- So it is one atomic unit. migrate.js wraps each file in BEGIN/COMMIT, so
-- either all of it applies or none of it does.
--
-- ── Ownership is DERIVED FROM EVIDENCE, never invented ──────────────────────
--
-- `system_settings.updated_by` carries the user id that last wrote each row.
-- On production 30 of 35 rows carry `usr-admin-001` (Abhishek Katiyar, admin of
-- Abhishek PT Studio), which is a provable owner — so those 30 are attributed
-- by joining through `users.organization_id`. That derivation is portable: it
-- works the same way on any environment, and it needs no hard-coded id.
--
-- The remaining 5 rows have `updated_by IS NULL`. They are, verbatim:
--
--   expiry_warn_days      30            numeric default
--   face_match_threshold  0.50          numeric default (for a feature that
--                                       has since been removed from the app)
--   gym_address           ''            empty
--   gym_name              'MY PT STUDIO' the PRODUCT name, not a studio name
--   gym_phone             ''            empty
--
-- There is no tenant data in any of them and no evidence of who owns them.
-- Attributing them to a studio would be inventing ownership, so this migration
-- does not. It moves them, verbatim and with their original timestamps, into
-- `system_settings_unattributed` and re-seeds those five keys per organization
-- from the application's own defaults. Nothing is deleted; the rows remain
-- inspectable, and the operator can restore any of them by hand if the
-- judgement above turns out to be wrong.
--
-- `feature_flags` has no `updated_by` column at all, and all four of its rows
-- are product defaults seeded before multi-tenancy existed (two of them,
-- face_checkin and voice_feedback, gate a feature that has been removed). The
-- whole table is therefore unattributable by the same standard, and gets the
-- same treatment: quarantine the originals, seed per organization.
--
-- ── Defaults ────────────────────────────────────────────────────────────────
--
-- The seeded values below are taken from the constants the application already
-- ships — GYM_DEFAULTS and PERM_DEFAULTS in routes/settings.js — plus a
-- documented default for every other key present in production. They are
-- deliberately duplicated here rather than imported: a migration must describe
-- the state of the database at the moment it ran, and must not change meaning
-- later because somebody edited a JavaScript constant.
--
-- Idempotent throughout: re-running finds the column present, the rows already
-- attributed, the quarantine already done and every seed row already there.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Quarantine tables — hold rows whose owner cannot be proven.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings_unattributed (
  key           TEXT PRIMARY KEY,
  value         TEXT,
  type          TEXT,
  description   TEXT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason        TEXT NOT NULL
);

COMMENT ON TABLE system_settings_unattributed IS
  'AUD-001 (migration 159): pre-multi-tenancy system_settings rows with no '
  'provable owning organization. Preserved verbatim rather than deleted or '
  'assigned to a studio by guesswork. Safe to drop once reviewed.';

CREATE TABLE IF NOT EXISTS feature_flags_unattributed (
  key           TEXT PRIMARY KEY,
  value         BOOLEAN,
  description   TEXT,
  updated_at    TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason        TEXT NOT NULL
);

COMMENT ON TABLE feature_flags_unattributed IS
  'AUD-001 (migration 159): pre-multi-tenancy feature_flags rows. The table '
  'had no updated_by column, so no row had a provable owner.';

-- Both quarantine tables follow the repository's standing convention for a new
-- table: RLS on, anon and authenticated revoked, deny-all policy. Without it a
-- table is reachable through PostgREST with the publishable key, which bypasses
-- the API and every tenant check in it — and these two hold the settings rows
-- whose ownership could not be established, which is precisely the content that
-- should not be readable by an anonymous caller.
--
-- Enforced by src/__tests__/rls.convention.test.js, which failed on this file
-- until these lines existed.
ALTER TABLE system_settings_unattributed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON system_settings_unattributed FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON system_settings_unattributed;
CREATE POLICY deny_all_direct_access ON system_settings_unattributed
  FOR ALL USING (false) WITH CHECK (false);

ALTER TABLE feature_flags_unattributed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON feature_flags_unattributed FROM anon, authenticated;
DROP POLICY IF EXISTS deny_all_direct_access ON feature_flags_unattributed;
CREATE POLICY deny_all_direct_access ON feature_flags_unattributed
  FOR ALL USING (false) WITH CHECK (false);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The tenant column.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Attribute by evidence: updated_by -> users.organization_id.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE system_settings s
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = s.updated_by
   AND u.organization_id IS NOT NULL
   AND s.organization_id IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Quarantine what could not be attributed.
-- ───────────────────────────────────────────────────────────────────────────
WITH moved AS (
  DELETE FROM system_settings
   WHERE organization_id IS NULL
  RETURNING key, value, type, description, updated_by, updated_at
)
INSERT INTO system_settings_unattributed
       (key, value, type, description, updated_by, updated_at, reason)
SELECT m.key, m.value, m.type, m.description, m.updated_by, m.updated_at,
       CASE WHEN m.updated_by IS NULL
            THEN 'no updated_by: pre-multi-tenancy seed default, no provable owner'
            ELSE 'updated_by did not resolve to a user with an organization'
       END
  FROM moved m
ON CONFLICT (key) DO NOTHING;

WITH moved AS (
  DELETE FROM feature_flags
   WHERE organization_id IS NULL
  RETURNING key, value, description, updated_at
)
INSERT INTO feature_flags_unattributed (key, value, description, updated_at, reason)
SELECT m.key, m.value, m.description, m.updated_at,
       'feature_flags has no updated_by column: no row had a provable owner'
  FROM moved m
ON CONFLICT (key) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Re-key on (organization_id, key).
--
--    DROP then ADD, in that order, because a table has exactly one primary
--    key. SET NOT NULL is safe here and not before: step 4 removed every row
--    that had no organization.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'system_settings'
       AND con.contype = 'p' AND pg_get_constraintdef(con.oid) = 'PRIMARY KEY (key)'
  ) THEN
    ALTER TABLE system_settings DROP CONSTRAINT system_settings_pkey;
    ALTER TABLE system_settings ALTER COLUMN organization_id SET NOT NULL;
    ALTER TABLE system_settings ADD CONSTRAINT system_settings_pkey
      PRIMARY KEY (organization_id, key);
    RAISE NOTICE 'system_settings primary key is now (organization_id, key)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'feature_flags'
       AND con.contype = 'p' AND pg_get_constraintdef(con.oid) = 'PRIMARY KEY (key)'
  ) THEN
    ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_pkey;
    ALTER TABLE feature_flags ALTER COLUMN organization_id SET NOT NULL;
    ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_pkey
      PRIMARY KEY (organization_id, key);
    RAISE NOTICE 'feature_flags primary key is now (organization_id, key)';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Seed every organization with a complete default set.
--
--    CROSS JOIN organizations, so the set is total by construction: there is
--    no ordering or looping in which an organization can be missed. NOT EXISTS
--    means a studio that already has a key keeps ITS value — the 30 attributed
--    rows above are never overwritten.
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO system_settings (organization_id, key, value, type, description, updated_at)
SELECT o.id, d.key, d.value, d.type, d.description, NOW()
  FROM organizations o
 CROSS JOIN (VALUES
    -- Identity and branding. Seeded from the organization's own name where we
    -- have one, so a new studio's Settings screen opens showing its own name
    -- rather than a placeholder (see the COALESCE below).
    ('studio_name',              '',        'string',  'Studio name shown across the app'),
    ('gym_name',                 '',        'string',  'Legacy alias of studio_name'),
    ('gym_address',              '',        'string',  'Street address'),
    ('gym_phone',                '',        'string',  'Public contact number'),
    ('location',                 '',        'string',  'Locality shown on invoices'),
    ('email',                    '',        'string',  'Contact email'),
    ('phone',                    '',        'string',  'Contact mobile'),
    ('name',                     '',        'string',  'Owner name'),

    -- Locale and finance
    ('timezone',                 'UTC+05:30', 'string', 'Studio timezone'),
    ('currency',                 'INR',     'string',  'Billing currency'),
    ('gst',                      '0',       'number',  'GST amount'),
    ('gst_rate',                 '0',       'number',  'GST percentage'),
    ('invoice_prefix',           '0',       'number',  'Invoice number prefix'),
    ('payment_terms',            '0',       'number',  'Payment terms in days'),
    ('expiry_warn_days',         '30',      'number',  'Warn this many days before a membership expires'),
    ('retention_period',         '',        'string',  'Data retention period'),

    -- Check-in. Values match GYM_DEFAULTS in routes/settings.js.
    ('geofence_lat',             '19.076',  'number',  'Check-in geofence latitude'),
    ('geofence_lng',             '72.8777', 'number',  'Check-in geofence longitude'),
    ('geofence_radius',          '100',     'number',  'Check-in geofence radius in metres'),
    ('enable_face_id',           'true',    'boolean', 'Allow Face ID check-in'),
    ('enable_touch_id',          'true',    'boolean', 'Allow Touch ID check-in'),
    ('enable_gps',               'true',    'boolean', 'Require GPS on check-in'),
    ('duplicate_window_minutes', '60',      'number',  'Ignore repeat check-ins within this window'),
    ('auto_checkout',            'false',   'boolean', 'Check members out automatically'),
    ('auto_checkout_minutes',    '120',     'number',  'Minutes before an automatic check-out'),
    ('check_in_method',          'qr',      'string',  'Check-in method'),
    ('face_match_threshold',     '0.50',    'number',  'Face match confidence threshold'),
    ('geo_fencing',              'true',    'boolean', 'Enforce the check-in geofence'),

    -- Notifications and product toggles
    ('email_notifications',      'true',    'boolean', 'Send email notifications'),
    ('sms_notifications',        'true',    'boolean', 'Send SMS notifications'),
    ('push_notifications',       'true',    'boolean', 'Send push notifications'),
    ('smart_reminders',          'true',    'boolean', 'Send smart reminders'),
    ('auto_renewals',            'true',    'boolean', 'Offer automatic renewals'),
    ('auto_backup',              'true',    'boolean', 'Automatic backups'),
    ('ai_insights',              'true',    'boolean', 'Show AI insights'),

    -- Role permissions. Values match PERM_DEFAULTS in routes/settings.js.
    -- NOTE: these are enforced only in the browser today (AUD-007). Making
    -- them per-organization is a prerequisite for enforcing them server-side,
    -- which is Phase 3 — this migration does not change what they do.
    ('perm_trainer_pt_module',        'true',  'boolean', 'Trainer: PT module'),
    ('perm_trainer_finance',          'false', 'boolean', 'Trainer: finance'),
    ('perm_trainer_reports',          'false', 'boolean', 'Trainer: reports'),
    ('perm_trainer_insights',         'false', 'boolean', 'Trainer: insights'),
    ('perm_trainer_staff_view',       'true',  'boolean', 'Trainer: view staff'),
    ('perm_trainer_settings',         'false', 'boolean', 'Trainer: settings'),
    ('perm_trainer_all_pt_clients',   'false', 'boolean', 'Trainer: all PT clients'),
    ('perm_trainer_commissions',      'true',  'boolean', 'Trainer: commissions'),
    ('perm_trainer_record_payment',   'false', 'boolean', 'Trainer: record payment'),
    ('perm_reception_pt_module',      'false', 'boolean', 'Reception: PT module'),
    ('perm_reception_finance',        'false', 'boolean', 'Reception: finance'),
    ('perm_reception_reports',        'false', 'boolean', 'Reception: reports'),
    ('perm_reception_insights',       'false', 'boolean', 'Reception: insights'),
    ('perm_reception_settings',       'false', 'boolean', 'Reception: settings'),
    ('perm_reception_staff_view',     'true',  'boolean', 'Reception: view staff'),
    ('perm_reception_record_payment', 'true',  'boolean', 'Reception: record payment')
 ) AS d(key, value, type, description)
 WHERE NOT EXISTS (
   SELECT 1 FROM system_settings s
    WHERE s.organization_id = o.id AND s.key = d.key
 );

-- A studio whose name we seeded blank gets its real name, so the Settings
-- screen opens showing the studio rather than an empty field. Only touches
-- rows this migration just created empty — never an existing value.
UPDATE system_settings s
   SET value = o.name
  FROM organizations o
 WHERE s.organization_id = o.id
   AND s.key IN ('studio_name', 'gym_name')
   AND COALESCE(s.value, '') = ''
   AND COALESCE(o.name, '') <> '';

INSERT INTO feature_flags (organization_id, key, value, description, updated_at)
SELECT o.id, d.key, d.value, d.description, NOW()
  FROM organizations o
 CROSS JOIN (VALUES
    ('auto_expire',        TRUE,  'Auto-expire memberships past end date'),
    ('birthday_reminders', TRUE,  'Send birthday notifications'),
    ('face_checkin',       FALSE, 'Face recognition check-in (feature removed from the app)'),
    ('voice_feedback',     FALSE, 'Voice feedback on check-in (feature removed from the app)')
 ) AS d(key, value, description)
 WHERE NOT EXISTS (
   SELECT 1 FROM feature_flags f
    WHERE f.organization_id = o.id AND f.key = d.key
 );

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Indexes — deliberately NONE.
--
--    The new primary key is (organization_id, key), so its unique index
--    already has organization_id as its LEADING column. That serves both
--    shapes this router issues:
--
--      WHERE organization_id = $1                  → index scan, leading col
--      WHERE organization_id = $1 AND key = $2     → index scan, both cols
--
--    A separate index on (organization_id) would be redundant with it, which
--    is exactly the class of duplication migration 135 exists to remove — it
--    dropped system_settings_key_idx and feature_flags_key_idx for duplicating
--    the old (key) primary key. Adding one here would undo that lesson in the
--    same file that changes the key.
--
--    NOTE for anyone adding a query later: after this migration there is no
--    longer any index with `key` as its leading column, so a lookup by key
--    ALONE (across organizations) is a sequential scan. Nothing in the
--    application does that — every query in routes/settings.js filters on
--    organization_id first — and at 51 rows per studio it would not matter if
--    it did. It is written down because the old (key) index disappearing is
--    the non-obvious consequence of this change.
-- ───────────────────────────────────────────────────────────────────────────

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Prove it worked, inside the same transaction.
--
--    RAISE EXCEPTION rather than RAISE WARNING, and deliberately unlike
--    migration 155's skip-and-warn. 155 tightens a constraint on data it does
--    not otherwise change, so refusing to tighten is a safe partial outcome.
--    Here a partial outcome is a studio with no settings at all — a blank
--    Settings screen and a check-in geofence at 0,0. Rolling back is strictly
--    better than committing that, and because migrate.js wraps each file in a
--    transaction, the rollback is complete and the previous behaviour is intact.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  orphan_settings BIGINT;
  orphan_flags    BIGINT;
  incomplete      TEXT;
  probe_keys      TEXT[] := ARRAY['studio_name', 'timezone', 'currency',
                                  'geofence_radius', 'perm_trainer_pt_module'];
BEGIN
  SELECT count(*) INTO orphan_settings FROM system_settings WHERE organization_id IS NULL;
  SELECT count(*) INTO orphan_flags    FROM feature_flags   WHERE organization_id IS NULL;

  IF orphan_settings > 0 OR orphan_flags > 0 THEN
    RAISE EXCEPTION
      'AUD-001 migration incomplete: % system_settings and % feature_flags rows still have no organization',
      orphan_settings, orphan_flags;
  END IF;

  SELECT string_agg(o.name, ', ') INTO incomplete
    FROM organizations o
   WHERE EXISTS (
     SELECT 1 FROM unnest(probe_keys) AS k(key)
      WHERE NOT EXISTS (
        SELECT 1 FROM system_settings s
         WHERE s.organization_id = o.id AND s.key = k.key
      )
   );

  IF incomplete IS NOT NULL THEN
    RAISE EXCEPTION
      'AUD-001 migration incomplete: these organizations are missing seeded settings: %',
      incomplete;
  END IF;

  RAISE NOTICE
    'AUD-001: settings are per-organization. % organizations, % settings rows, % flag rows, % quarantined.',
    (SELECT count(*) FROM organizations),
    (SELECT count(*) FROM system_settings),
    (SELECT count(*) FROM feature_flags),
    (SELECT count(*) FROM system_settings_unattributed)
      + (SELECT count(*) FROM feature_flags_unattributed);
END $$;
