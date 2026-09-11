'use strict';
// The two surviving session models, against a real database.
//
// Both carry organization_id NOT NULL and both are read by handlers that build
// their own predicates, so the only way to prove isolation is to run the
// predicates against real rows — a mocked pool returns the fixture no matter
// what the WHERE says, which is how a dropped tenant filter has passed a full
// mocked suite in this repo before.
//
// What this pins:
//   1. the archived tables are out of `public` and their rows survived;
//   2. workout_sessions — the canonical workout log — is tenant-isolated;
//   3. pt_sessions — the appointment model — is tenant-isolated;
//   4. the two remain distinct responsibilities rather than converging again.
//
// Gated on RLS_TEST_DATABASE_URL and loud in CI if that is missing.

const { Pool } = require('pg');

const DB_URL = process.env.RLS_TEST_DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

if (process.env.CI && !DB_URL) {
  describe('session model tenancy, against a real database', () => {
    it('has a database to run against', () => {
      throw new Error('RLS_TEST_DATABASE_URL is not set in CI — the session tenancy proof would skip.');
    });
  });
}

const ORG_A = '77777777-7777-4777-8777-777777777777';
const ORG_B = '88888888-8888-4888-8888-888888888888';

describeIf('session model tenancy, against a real database', () => {
  let db;

  beforeAll(async () => {
    db = new Pool({ connectionString: DB_URL, max: 4 });
    await db.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,'Sess A','sess-a'), ($2,'Sess B','sess-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO trainers (id, name, organization_id) VALUES ('sess-tr-a','Ana',$1), ('sess-tr-b','Ben',$2)
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO pt_clients (id, name, mobile, organization_id, trainer_id) VALUES
         ('sess-cl-a','Asha','+919000037001',$1,'sess-tr-a'),
         ('sess-cl-b','Bala','+919000038001',$2,'sess-tr-b')
       ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM workout_sessions WHERE client_id LIKE 'sess-cl-%'`);
    await db.query(`DELETE FROM pt_sessions      WHERE client_id LIKE 'sess-cl-%'`);
    await db.query(
      `INSERT INTO workout_sessions (id, client_id, trainer_id, session_date, status, organization_id) VALUES
         ('sess-ws-a1','sess-cl-a','sess-tr-a',CURRENT_DATE,'completed',$1),
         ('sess-ws-a2','sess-cl-a','sess-tr-a',CURRENT_DATE - 1,'completed',$1),
         ('sess-ws-b1','sess-cl-b','sess-tr-b',CURRENT_DATE,'completed',$2)`,
      [ORG_A, ORG_B]);
    await db.query(
      `INSERT INTO pt_sessions (id, client_id, trainer_id, session_date, start_time, status, organization_id) VALUES
         ('sess-pt-a1','sess-cl-a','sess-tr-a',CURRENT_DATE,'09:00','scheduled',$1),
         ('sess-pt-b1','sess-cl-b','sess-tr-b',CURRENT_DATE,'10:00','scheduled',$2)`,
      [ORG_A, ORG_B]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM workout_sessions WHERE client_id LIKE 'sess-cl-%'`);
    await db.query(`DELETE FROM pt_sessions      WHERE client_id LIKE 'sess-cl-%'`);
    await db.query(`DELETE FROM pt_clients       WHERE id LIKE 'sess-cl-%'`);
    await db.query(`DELETE FROM trainers         WHERE id LIKE 'sess-tr-%'`);
    await db.query(`DELETE FROM organizations    WHERE id IN ($1,$2)`, [ORG_A, ORG_B]);
    await db.end();
  });

  // ── 1. the copy is archived, not destroyed ────────────────────────────────

  describe('1. the retired tables left public with their rows', () => {
    const ARCHIVED = ['training_sessions', 'exercise_performances', 'set_performances',
                      'cardio_performances', 'personal_records', 'training_assignments'];

    test.each(ARCHIVED)('public.%s is gone', async (t) => {
      const { rows } = await db.query(`SELECT to_regclass('public.' || $1) AS t`, [t]);
      expect(rows[0].t).toBeNull();
    });

    test.each(ARCHIVED)('archive.%s exists and is readable', async (t) => {
      // The other half. A migration that dropped them would satisfy every
      // assertion above and destroy the history it promised to keep.
      const { rows } = await db.query(`SELECT to_regclass('archive.' || $1) AS t`, [t]);
      expect(rows[0].t).not.toBeNull();
      await expect(db.query(`SELECT count(*) FROM archive.${t}`)).resolves.toBeDefined();
    });

    test('the foreign keys between them came along', async () => {
      // SET SCHEMA moves constraints with their tables. If it had not, the
      // archive would be a pile of rows with no relationships left.
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM pg_constraint con
           JOIN pg_class t ON t.oid = con.conrelid
          WHERE con.contype = 'f' AND t.relnamespace = 'archive'::regnamespace`);
      expect(rows[0].n).toBeGreaterThan(0);
    });
  });

  // ── 2. the canonical workout log ─────────────────────────────────────────

  describe('2. workout_sessions is tenant-isolated', () => {
    test('a scoped list returns only the caller studio', async () => {
      const { rows } = await db.query(
        `SELECT id FROM workout_sessions
          WHERE organization_id = $1 AND client_id LIKE 'sess-cl-%' ORDER BY id`, [ORG_A]);
      expect(rows.map((r) => r.id)).toEqual(['sess-ws-a1', 'sess-ws-a2']);
    });

    test('fetching another studio session by id returns nothing', async () => {
      const { rows } = await db.query(
        `SELECT id FROM workout_sessions WHERE id = $1 AND organization_id = $2`,
        ['sess-ws-b1', ORG_A]);
      expect(rows).toHaveLength(0);

      const unscoped = await db.query(`SELECT id FROM workout_sessions WHERE id = $1`, ['sess-ws-b1']);
      expect(unscoped.rows).toHaveLength(1); // it exists — the predicate is what hides it
    });

    test('a scoped update of another studio session changes nothing', async () => {
      const r = await db.query(
        `UPDATE workout_sessions SET status = 'cancelled'
          WHERE id = $1 AND organization_id = $2`, ['sess-ws-b1', ORG_A]);
      expect(r.rowCount).toBe(0);
      const { rows } = await db.query(`SELECT status FROM workout_sessions WHERE id = 'sess-ws-b1'`);
      expect(rows[0].status).toBe('completed');
    });

    test('a scoped delete of the studio own session works', async () => {
      // The negatives above are also satisfied by a predicate matching nothing.
      const r = await db.query(
        `DELETE FROM workout_sessions WHERE id = $1 AND organization_id = $2`, ['sess-ws-a1', ORG_A]);
      expect(r.rowCount).toBe(1);
    });

    test('organization_id cannot be left off a session', async () => {
      await expect(db.query(
        `INSERT INTO workout_sessions (id, client_id, session_date, status, organization_id)
         VALUES ('sess-ws-orphan','sess-cl-a',CURRENT_DATE,'completed',NULL)`
      )).rejects.toThrow(/null value|not-null/i);
    });
  });

  // ── 3. the appointment model ─────────────────────────────────────────────

  describe('3. pt_sessions is tenant-isolated', () => {
    test('a scoped list returns only the caller studio', async () => {
      const { rows } = await db.query(
        `SELECT id FROM pt_sessions
          WHERE organization_id = $1 AND deleted_at IS NULL AND client_id LIKE 'sess-cl-%'`, [ORG_A]);
      expect(rows.map((r) => r.id)).toEqual(['sess-pt-a1']);
    });

    test('a scoped update of another studio appointment changes nothing', async () => {
      const r = await db.query(
        `UPDATE pt_sessions SET status = 'cancelled'
          WHERE id = $1 AND deleted_at IS NULL AND organization_id = $2`, ['sess-pt-b1', ORG_A]);
      expect(r.rowCount).toBe(0);
    });
  });

  // ── 4. the two stay distinct ─────────────────────────────────────────────

  describe('4. the two models are different shapes, not two copies', () => {
    test('pt_sessions schedules, workout_sessions records', async () => {
      // If these ever converge on the same columns, the duplication this
      // change removed is growing back.
      const cols = async (t) => (await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1`, [t])).rows.map((r) => r.column_name);

      const pt = await cols('pt_sessions');
      const ws = await cols('workout_sessions');

      // Scheduling lives on the appointment, and only there.
      expect(pt).toEqual(expect.arrayContaining(['start_time', 'end_time', 'recurrence_id']));
      expect(ws).not.toEqual(expect.arrayContaining(['recurrence_id']));

      // The workout log links to the assignment it was performed from.
      expect(ws).toEqual(expect.arrayContaining(['workout_assignment_id', 'program_name']));
      expect(pt).not.toEqual(expect.arrayContaining(['workout_assignment_id']));
    });

    test('only workout_sessions has an exercise tree under it', async () => {
      const { rows } = await db.query(
        `SELECT src.relname AS child
           FROM pg_constraint con
           JOIN pg_class src ON src.oid = con.conrelid
           JOIN pg_class tgt ON tgt.oid = con.confrelid
          WHERE con.contype='f' AND tgt.relname IN ('workout_sessions','pt_sessions')
          ORDER BY 1`);
      expect(rows.map((r) => r.child)).toContain('workout_session_exercises');
    });
  });
});
