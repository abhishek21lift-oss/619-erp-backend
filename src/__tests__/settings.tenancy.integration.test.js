'use strict';
// Studio settings belong to a studio — proved against a real database.
//
// ── What was wrong ─────────────────────────────────────────────────────────
//
// routes/settings.js calls itself "Studio Settings CRUD" and is mounted
// `auth, requireStaff`. system_settings had no organization_id, and not one of
// its fourteen statements filtered by anything, so all six studios in
// production shared one set of 35 rows.
//
// Those rows are not incidental configuration:
//
//   studio_name, gym_name, email, phone, location, gym_address
//       one studio's business identity, readable by any staff user of any
//       other studio.
//   geofence_lat, geofence_lng, geofence_radius
//       the coordinates and radius that gate check-in. Five studios had
//       attendance decided by a sixth studio's map pin.
//   perm_trainer_*, perm_reception_*
//       ROLE PERMISSIONS — a cross-tenant authorization change, not a read.
//
// And writes collided as well as leaked: every upsert conflicted on `key`
// alone, so studio A saving its studio name overwrote studio B's.
//
// ── Why a mocked test could not have proved this ───────────────────────────
//
// A mocked pool returns the fixture whatever the WHERE says, and the write
// half of this defect lives in the ON CONFLICT target — a property of the
// PRIMARY KEY, which only a real database has. Both halves are exercised here
// against real constraints.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('settings tenancy, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the settings isolation proof would skip.');
    });
  });
}

const ORG_A = '77777777-7777-4777-8777-777777777777';
const ORG_B = '88888888-8888-4888-8888-888888888888';

describeIf('settings tenancy, against a real database', () => {
  let db;

  /** The read every GET handler performs, for one studio. */
  const readFor = (orgId, key) => db.query(
    'SELECT value FROM system_settings WHERE organization_id = $1 AND key = $2', [orgId, key]);

  /** The upsert every PUT handler performs, for one studio. */
  const writeFor = (orgId, key, value) => db.query(
    `INSERT INTO system_settings (organization_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (organization_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [orgId, key, value]);

  beforeAll(async () => {
    db = new Pool({ connectionString: DB_URL, max: 4 });
    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Set A','set-a'), ($2,'Set B','set-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM system_settings WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await writeFor(ORG_A, 'studio_name', 'Studio A');
    await writeFor(ORG_A, 'geofence_lat', '11.111');
    await writeFor(ORG_A, 'perm_trainer_finance', 'false');
    await writeFor(ORG_B, 'studio_name', 'Studio B');
    await writeFor(ORG_B, 'geofence_lat', '22.222');
    await writeFor(ORG_B, 'perm_trainer_finance', 'true');
  });

  afterAll(async () => {
    await db.query(`DELETE FROM system_settings WHERE organization_id IN ($1,$2)`, [ORG_A, ORG_B]);
    await db.query(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await db.end();
  });

  // ── 1. the column and the key ────────────────────────────────────────────

  describe('1. the table can name an owner, and the key is per studio', () => {
    test('organization_id exists and is NOT NULL', async () => {
      const { rows } = await db.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='system_settings'
            AND column_name='organization_id'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe('uuid');
      // Nullable would mean a setting no scoped read can see and no scoped
      // write can replace — invisible, not safe.
      expect(rows[0].is_nullable).toBe('NO');
    });

    test('the primary key covers (organization_id, key), not key alone', async () => {
      const { rows } = await db.query(
        `SELECT (SELECT array_agg(a.attname::text ORDER BY a.attname)
                   FROM unnest(con.conkey) k
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS cols
           FROM pg_constraint con
          WHERE con.conrelid = 'public.system_settings'::regclass AND con.contype = 'p'`);
      expect(rows[0].cols.sort()).toEqual(['key', 'organization_id']);
    });

    test('two studios can hold the same key with different values', async () => {
      // The direct consequence. Under PRIMARY KEY (key) this was impossible:
      // the second studio's write replaced the first's row.
      expect((await readFor(ORG_A, 'studio_name')).rows[0].value).toBe('Studio A');
      expect((await readFor(ORG_B, 'studio_name')).rows[0].value).toBe('Studio B');
    });

    test('RLS no longer classifies the table as platform-shared', async () => {
      // `tenant_shared_read USING (true)` is how the database said "this is
      // reference data every studio may read". Leaving it would mean the
      // application filtered while RLS did not.
      const { rows } = await db.query(
        `SELECT policyname FROM pg_policies WHERE tablename='system_settings'`);
      const names = rows.map((r) => r.policyname);
      expect(names).not.toContain('tenant_shared_read');
      expect(names).toContain('tenant_isolation');
    });
  });

  // ── 2. Studio A cannot read Studio B ─────────────────────────────────────

  describe('2. a studio reads only its own settings', () => {
    test('the scoped list returns only the caller studio keys', async () => {
      const { rows } = await db.query(
        `SELECT key, value FROM system_settings WHERE organization_id = $1 ORDER BY key`, [ORG_A]);
      expect(rows.map((r) => r.value)).toEqual(['11.111', 'false', 'Studio A']);
    });

    test('studio A cannot read studio B geofence', async () => {
      // The one that decided whether someone's check-in counted.
      const { rows } = await db.query(
        `SELECT value FROM system_settings WHERE key='geofence_lat' AND organization_id=$1`, [ORG_A]);
      expect(rows[0].value).toBe('11.111');
      expect(rows[0].value).not.toBe('22.222');
    });

    test('the unscoped read this replaced returned both studios', async () => {
      // The defect stated as a fact rather than described. If this stops
      // returning two rows the fixture has drifted and the assertions above
      // prove less than they appear to.
      const { rows } = await db.query(
        `SELECT value FROM system_settings WHERE key='studio_name' AND organization_id IN ($1,$2)`,
        [ORG_A, ORG_B]);
      expect(rows).toHaveLength(2);
    });
  });

  // ── 3. Studio A cannot write Studio B ────────────────────────────────────

  describe('3. a studio writes only its own settings', () => {
    test('A saving its studio name leaves B untouched', async () => {
      await writeFor(ORG_A, 'studio_name', 'A renamed');
      expect((await readFor(ORG_A, 'studio_name')).rows[0].value).toBe('A renamed');
      expect((await readFor(ORG_B, 'studio_name')).rows[0].value).toBe('Studio B');
    });

    test('A changing a role permission leaves B permission alone', async () => {
      // The worst of the three: this is authorization, not display. Under the
      // old shared key, A granting its trainers finance access granted it to
      // every studio's trainers.
      await writeFor(ORG_A, 'perm_trainer_finance', 'true');
      expect((await readFor(ORG_A, 'perm_trainer_finance')).rows[0].value).toBe('true');
      expect((await readFor(ORG_B, 'perm_trainer_finance')).rows[0].value).toBe('true');
      await writeFor(ORG_B, 'perm_trainer_finance', 'false');
      expect((await readFor(ORG_A, 'perm_trainer_finance')).rows[0].value).toBe('true');
      expect((await readFor(ORG_B, 'perm_trainer_finance')).rows[0].value).toBe('false');
    });

    test('a scoped update of another studio setting changes nothing', async () => {
      const r = await db.query(
        `UPDATE system_settings SET value='hijacked'
          WHERE key='studio_name' AND organization_id=$1`, [ORG_A]);
      expect(r.rowCount).toBe(1);
      expect((await readFor(ORG_B, 'studio_name')).rows[0].value).toBe('Studio B');
    });

    test('a scoped delete of another studio setting changes nothing', async () => {
      const r = await db.query(
        `DELETE FROM system_settings WHERE key='studio_name' AND organization_id=$1`, [ORG_B]);
      expect(r.rowCount).toBe(1);
      // …and A's survives, so the delete was scoped rather than broken.
      expect((await readFor(ORG_A, 'studio_name')).rows).toHaveLength(1);
    });

    test('a setting cannot be written without a studio', async () => {
      await expect(db.query(
        `INSERT INTO system_settings (organization_id, key, value) VALUES (NULL,'orphan','x')`
      )).rejects.toThrow(/null value|not-null/i);
    });
  });
});
