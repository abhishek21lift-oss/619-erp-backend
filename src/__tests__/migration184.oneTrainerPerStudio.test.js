'use strict';
// 184_one_trainer_per_studio.sql, run against a real PostgreSQL.
//
// Following 167's reasoning rather than the text-assertion style used by most
// migration tests here: 184 links accounts and builds a constraint, and the
// only questions worth answering are whether the right row got linked and
// whether the constraint actually rejects what it claims to. A regex over the
// file cannot tell a correct HAVING clause from one that links every owner in
// the database to the wrong trainer.
//
// ── The behaviour that matters most ────────────────────────────────────────
//
// migrate.js:122-131 gives each migration its own transaction and rethrows on
// failure, and server.js runs migrations before serving traffic — so a
// migration that throws stops the deploy. 184 runs at deploy time, by which
// point a studio may have gained a second active trainer that would make its
// index unbuildable. The test that earns its place here is the one asserting
// that this produces a WARNING and a missing index rather than an exception:
// that is the difference between a constraint that has to wait and an outage.
//
// ── Nothing is left behind ─────────────────────────────────────────────────
//
// Every test runs inside one transaction that is always rolled back, including
// the index the migration creates. The database is shared with the isolation
// suite, and leaving trainers_one_active_per_org behind would make every later
// fixture that wants two trainers in one org fail for a reason nothing states.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

// Same reasoning as 167 and the isolation proof: skipping is right on a laptop
// without a database and wrong in CI, where a missing URL means the wiring
// broke and this proof quietly stopped running.
if (process.env.CI && !DB_URL) {
  describe('184 one trainer per studio, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error(
        'RLS_TEST_DATABASE_URL is not set in CI, so the one-trainer-per-studio '
        + 'proof never ran. Repair .github/workflows/ci.yml.'
      );
    });
  });
}

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '184_one_trainer_per_studio.sql'),
  'utf8'
);

describeIf('184_one_trainer_per_studio.sql', () => {
  let pool;
  let db;
  let warnings;

  beforeAll(() => { pool = new Pool({ connectionString: DB_URL }); });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    db = await pool.connect();
    warnings = [];
    db.on('notice', (n) => warnings.push(`${n.severity}: ${n.message}`));
    await db.query('BEGIN');
    // Every case starts from the state 184 expects to find: no index yet.
    // Without this the suite cannot even SEED a studio with two active
    // trainers — the index it is testing the creation of would reject the
    // fixture. Transactional, so the rollback puts it back.
    await db.query('DROP INDEX IF EXISTS trainers_one_active_per_org');
  });

  afterEach(async () => {
    await db.query('ROLLBACK');
    db.removeAllListeners('notice');
    db.release();
  });

  /** organizations.id is uuid while trainers.id and users.id are text, so the
   *  studio id has to be a real uuid. Derived from the tag rather than random
   *  so a failure names the same studio every run. */
  const orgId = (tag) => {
    const h = require('crypto').createHash('md5').update(`mig184-${tag}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };

  /** A studio, its trainers and its owner. Text ids are prefixed so they cannot
   *  collide with the isolation suite's committed fixtures. */
  async function seedStudio(tag, { trainers = [], adminTrainerId = null } = {}) {
    const org = orgId(tag);
    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [org, `Studio ${tag}`, `mig184-${tag}`]);
    for (const t of trainers) {
      await db.query(
        `INSERT INTO trainers (id, name, organization_id, status, deleted_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [t.id, t.name || t.id, org, t.status || 'active', t.deletedAt || null]);
    }
    await db.query(
      `INSERT INTO users (id, name, email, password, role, organization_id, trainer_id)
       VALUES ($1, $2, $3, 'x', 'admin', $4, $5)`,
      [`mig184-admin-${tag}`, `Owner ${tag}`, `owner-${tag}@mig184.test`, org, adminTrainerId]);
    return org;
  }

  const adminLink = async (tag) => (await db.query(
    'SELECT trainer_id FROM users WHERE id = $1', [`mig184-admin-${tag}`]
  )).rows[0].trainer_id;

  const indexExists = async () => (await db.query(
    `SELECT to_regclass('public.trainers_one_active_per_org') IS NOT NULL AS present`
  )).rows[0].present;

  /** The migration only builds its index if the WHOLE database is clean, and
   *  this one is shared. Archiving pre-existing duplicates inside the
   *  transaction is setup, not part of what is under test. */
  async function makeEveryOtherStudioClean() {
    await db.query(`
      UPDATE trainers SET status = 'inactive'
       WHERE deleted_at IS NULL AND status = 'active'
         AND id NOT IN (
           SELECT min(id) FROM trainers
            WHERE deleted_at IS NULL AND status = 'active'
            GROUP BY organization_id)`);
  }

  const run = () => db.query(MIGRATION_SQL);

  describe('linking an owner to their studio trainer', () => {
    it('links an owner whose trainer_id is NULL to the sole active trainer', async () => {
      // The production case: Abhishek PT Studio, whose admin was seeded rather
      // than created through signup and so never got the link.
      await seedStudio('solo', { trainers: [{ id: 'mig184-tr-solo' }] });
      expect(await adminLink('solo')).toBeNull();

      await run();

      expect(await adminLink('solo')).toBe('mig184-tr-solo');
    });

    it('leaves an owner that is already linked exactly as it is', async () => {
      // Even when the link looks odd. Overwriting would be a repoint, and this
      // migration repoints nothing.
      await seedStudio('linked', {
        trainers: [{ id: 'mig184-tr-linked' }, { id: 'mig184-tr-old', status: 'inactive' }],
        adminTrainerId: 'mig184-tr-old',
      });

      await run();

      expect(await adminLink('linked')).toBe('mig184-tr-old');
    });

    it('refuses to link when the studio has two active trainers', async () => {
      // Ambiguous: picking one would silently decide who the owner is.
      await seedStudio('two', {
        trainers: [{ id: 'mig184-tr-two-a' }, { id: 'mig184-tr-two-b' }],
      });

      await run();

      expect(await adminLink('two')).toBeNull();
      expect(warnings.join('\n')).toMatch(/Studio two has 2 active trainers/);
    });

    it('leaves a studio with no active trainer alone, without erroring', async () => {
      await seedStudio('none', { trainers: [{ id: 'mig184-tr-gone', status: 'inactive' }] });

      await expect(run()).resolves.toBeDefined();

      expect(await adminLink('none')).toBeNull();
      expect(warnings.join('\n')).toMatch(/Studio none has NO active trainer/);
    });

    it('ignores soft-deleted trainers when deciding the studio has exactly one', async () => {
      // deleted_at is not status: a soft-deleted row is still status='active'.
      await seedStudio('softdel', {
        trainers: [
          { id: 'mig184-tr-live' },
          { id: 'mig184-tr-dead', deletedAt: new Date().toISOString() },
        ],
      });

      await run();

      expect(await adminLink('softdel')).toBe('mig184-tr-live');
    });
  });

  describe('the enforcement index', () => {
    it('is created when every studio is clean, and then rejects a second active trainer', async () => {
      await seedStudio('clean', { trainers: [{ id: 'mig184-tr-clean' }] });
      await makeEveryOtherStudioClean();

      await run();

      expect(await indexExists()).toBe(true);
      await expect(db.query(
        `INSERT INTO trainers (id, name, organization_id, status)
         VALUES ('mig184-tr-second', 'Second', $1, 'active')`,
        [orgId('clean')]
      )).rejects.toThrow(/trainers_one_active_per_org/);
    });

    it('still allows an INACTIVE second trainer, so archiving stays possible', async () => {
      // The partial index is about who is active now. A studio accumulates
      // archived trainers over time and every one keeps its history.
      await seedStudio('archive', { trainers: [{ id: 'mig184-tr-arch' }] });
      await makeEveryOtherStudioClean();

      await run();

      await expect(db.query(
        `INSERT INTO trainers (id, name, organization_id, status)
         VALUES ('mig184-tr-arch2', 'Archived', $1, 'inactive')`,
        [orgId('archive')]
      )).resolves.toBeDefined();
    });

    it('WARNS and skips rather than throwing when a studio has two active trainers', async () => {
      // The whole reason this migration does not RAISE EXCEPTION. A throw here
      // would roll back the transaction migrate.js opened and stop the deploy,
      // over a row 184 did not create.
      await seedStudio('block', {
        trainers: [{ id: 'mig184-tr-b1' }, { id: 'mig184-tr-b2' }],
      });

      await expect(run()).resolves.toBeDefined();

      expect(await indexExists()).toBe(false);
      expect(warnings.join('\n')).toMatch(/NOT creating trainers_one_active_per_org/);
      expect(warnings.join('\n')).toMatch(/Studio block \(2\)/);
    });

    it('does not fail when the index already exists', async () => {
      await seedStudio('again', { trainers: [{ id: 'mig184-tr-again' }] });
      await makeEveryOtherStudioClean();
      await run();

      await expect(run()).resolves.toBeDefined();
      expect(await indexExists()).toBe(true);
    });
  });

  describe('what it must not touch', () => {
    it('leaves pt_commissions, pt_payouts and leave_requests completely alone', async () => {
      // 184 no longer archives or repoints anything, so these should be
      // untouched by construction. Asserted anyway: it is the invariant the
      // whole design of this change rests on, and it is cheap to hold.
      const snapshot = async () => (await db.query(`
        SELECT (SELECT count(*) FROM pt_commissions) AS commissions,
               (SELECT count(*) FROM pt_payouts)     AS payouts,
               (SELECT count(*) FROM leave_requests) AS leave,
               (SELECT count(*) FROM pt_clients)     AS clients,
               (SELECT count(*) FROM trainers)       AS trainers,
               (SELECT COALESCE(md5(string_agg(id || ':' || status, '|' ORDER BY id)), '-')
                  FROM trainers)                     AS trainer_status`)).rows[0];

      await seedStudio('untouched', { trainers: [{ id: 'mig184-tr-un' }] });
      const before = await snapshot();

      await run();

      expect(await snapshot()).toEqual(before);
    });

    it('links only admins, never trainer or member logins', async () => {
      // users.trainer_id means "I am this trainer" on a staff row and "my
      // trainer" on a member row (client-login.js:168-184). Same column, two
      // meanings — this migration is only entitled to set the first.
      const org = await seedStudio('roles', { trainers: [{ id: 'mig184-tr-roles' }] });
      for (const role of ['trainer', 'member', 'manager', 'reception']) {
        await db.query(
          `INSERT INTO users (id, name, email, password, role, organization_id, trainer_id)
           VALUES ($1, $2, $3, 'x', $4, $5, NULL)`,
          [`mig184-u-${role}`, role, `${role}@mig184.test`, role, org]);
      }

      await run();

      const { rows } = await db.query(
        `SELECT role, trainer_id FROM users WHERE id LIKE 'mig184-u-%' ORDER BY role`);
      expect(rows.every((r) => r.trainer_id === null)).toBe(true);
      expect(rows).toHaveLength(4);
    });
  });

  describe('idempotence', () => {
    it('a second run changes nothing', async () => {
      await seedStudio('idem', { trainers: [{ id: 'mig184-tr-idem' }] });
      await makeEveryOtherStudioClean();

      await run();
      const after1 = (await db.query(
        `SELECT COALESCE(md5(string_agg(id || ':' || COALESCE(trainer_id, '-'), '|' ORDER BY id)), '-') AS h
           FROM users WHERE role = 'admin'`)).rows[0].h;

      await run();
      const after2 = (await db.query(
        `SELECT COALESCE(md5(string_agg(id || ':' || COALESCE(trainer_id, '-'), '|' ORDER BY id)), '-') AS h
           FROM users WHERE role = 'admin'`)).rows[0].h;

      expect(after2).toBe(after1);
    });
  });
});
